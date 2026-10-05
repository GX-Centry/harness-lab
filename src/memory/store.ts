/**
 * MemoryStore —— 记忆域的持久化层（SQLite，与 SessionStore 共享同一数据库文件）。
 *
 * 它在数据流中的位置（对齐 01-architecture §3「memory/」）：
 *
 *   query 开始 ── retrieve ──→ 打分检索 ──→ 注入 profile/task 层
 *   query 终结 ── trigger  ──→ 写入白名单 ──→ [本文件] memories 表
 *
 * 三层记忆模型（03-module-guide §2.9）：
 *   ① 会话内记忆   —— 「刚才聊过什么」：由 Session 天然持有（messages 表），
 *      不需要本文件参与；
 *   ② 跨会话事实   —— kind='fact'：项目事实、用户环境、任务结论等
 *      「换个会话也应该知道」的信息；
 *   ③ 偏好         —— kind='preference'：风格与行为偏好（注入 profile 层）。
 *   本表只存 ②③（跨会话记忆）——「记忆」这个词在工程上必须收窄为
 *   「值得跨会话延续的最少信息」，否则会退化成「把所有对话存两遍」。
 *
 * 为什么与 SessionStore 共享同一个数据库文件：
 *   见 session/store.ts 文件头「共享存储层」v1 边界——本文件复用其
 *   openDatabase()/resolveStorePath() 辅助，表名（memories）即命名空间。
 *   一个文件 = 一套备份/事务边界，跨域查询（如 /memory 统计）无需 ATTACH。
 *
 * 存储层保持「哑」：
 *   本文件不发事件、不做检索打分、不判断「该不该记」——那些分别是
 *   MemoryManager（事件上报）、retriever.ts（检索）、trigger.ts（白名单）
 *   的职责。分层目标是「本文件可被单测直接驱动，无需总线与配置」。
 *
 * 依赖方向：memory/store.ts → session/store.ts（openDatabase）+ errors。
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { HarnessError } from '../errors.ts';
import { openDatabase } from '../session/store.ts';

// ===========================================================================
// §1 记录形状
// ===========================================================================

/** 跨会话记忆的两种类型（会话内记忆不在此列——由 Session 持有） */
export const MEMORY_KINDS = ['fact', 'preference'] as const;

/** 记忆类型（'fact' 事实 / 'preference' 偏好；与 events.ts 的 kind:string 兼容） */
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** 一条跨会话记忆（存储形状即对外形状——v1 没有额外的投影视图） */
export interface MemoryRecord {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly content: string;
  /** 来源会话（可空：未来支持手工导入/系统预置的记忆） */
  readonly sourceSessionId: string | undefined;
  readonly createdAt: number;
}

/** write 的输入（id / createdAt 由存储层生成——调用方不需要关心） */
export interface MemoryWriteInput {
  readonly kind: MemoryKind;
  readonly content: string;
  readonly sourceSessionId?: string | undefined;
}

// ===========================================================================
// §2 行转换（SQLite 弱类型边界的收窄）
// ===========================================================================

type SqlRow = Record<string, string | number | bigint | Uint8Array | null>;

function requireString(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new HarnessError(
      'internal_error',
      `记忆表列 ${column} 类型异常（期望 string，实得 ${typeof value}）`,
      { where: 'memory/store' },
    );
  }
  return value;
}

function requireNumber(row: SqlRow, column: string): number {
  const value = row[column];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new HarnessError(
    'internal_error',
    `记忆表列 ${column} 类型异常（期望 number，实得 ${typeof value}）`,
    { where: 'memory/store' },
  );
}

function requireKind(row: SqlRow, column: string): MemoryKind {
  const value = requireString(row, column);
  const kind = MEMORY_KINDS.find((candidate) => candidate === value);
  if (kind === undefined) {
    throw new HarnessError('internal_error', `记忆表列 ${column} 含非法类型：${value}`, {
      where: 'memory/store',
    });
  }
  return kind;
}

function toRecord(row: SqlRow): MemoryRecord {
  const sourceSessionId = row['source_session_id'];
  return {
    id: requireString(row, 'id'),
    kind: requireKind(row, 'kind'),
    content: requireString(row, 'content'),
    sourceSessionId: typeof sourceSessionId === 'string' ? sourceSessionId : undefined,
    createdAt: requireNumber(row, 'created_at'),
  };
}

// ===========================================================================
// §3 MemoryStore
// ===========================================================================

export interface MemoryStoreOptions {
  /** 时钟注入（测试固定时钟；默认 Date.now） */
  readonly now?: () => number;
  /** id 生成器注入（测试确定性；默认 `m_<uuid>`） */
  readonly generateId?: () => string;
}

export class MemoryStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly generateId: () => string;

  constructor(dbPath: string, options: MemoryStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.generateId = options.generateId ?? (() => `m_${randomUUID()}`);
    this.db = openDatabase(dbPath);
    this.migrate();
  }

  /** DDL 幂等迁移（本域只关心 memories 表——表名即命名空间） */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id                TEXT PRIMARY KEY,
        kind              TEXT NOT NULL,
        content           TEXT NOT NULL,
        source_session_id TEXT,
        created_at        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind, created_at);
    `);
  }

  /** 写入一条记忆并返回它（写入即事实——「先事实后观测」纪律的起点） */
  write(input: MemoryWriteInput): MemoryRecord {
    if (input.content.trim() === '') {
      throw new HarnessError('input_error', '记忆内容为空，拒绝写入', { where: 'memory/store' });
    }
    const record: MemoryRecord = {
      id: this.generateId(),
      kind: input.kind,
      content: input.content,
      sourceSessionId: input.sourceSessionId,
      createdAt: this.now(),
    };
    this.db
      .prepare(
        'INSERT INTO memories (id, kind, content, source_session_id, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        record.id,
        record.kind,
        record.content,
        record.sourceSessionId ?? null,
        record.createdAt,
      );
    return record;
  }

  /**
   * 读取记忆（最近优先）。
   *
   * 检索优化说明：v1 全量扫表 + 内存打分（教学规模足够）；
   * 演进路径是倒排索引/embedding 向量列（见 docs 待决清单第 3 条），
   * 但那是「检索」的优化——存储形状不变，换的只是 retriever 实现。
   */
  list(options: { readonly kind?: MemoryKind; readonly limit?: number } = {}): MemoryRecord[] {
    const rows =
      options.kind !== undefined
        ? this.db
            .prepare(
              'SELECT * FROM memories WHERE kind = ? ORDER BY created_at DESC, rowid DESC',
            )
            .all(options.kind)
        : this.db
            .prepare('SELECT * FROM memories ORDER BY created_at DESC, rowid DESC')
            .all();
    const records = rows.map((row) => toRecord(row));
    return options.limit !== undefined ? records.slice(0, options.limit) : records;
  }

  /** 记忆总数（可观测面：/memory 统计、测试断言） */
  count(kind?: MemoryKind): number {
    const row =
      kind !== undefined
        ? this.db.prepare('SELECT COUNT(*) AS c FROM memories WHERE kind = ?').get(kind)
        : this.db.prepare('SELECT COUNT(*) AS c FROM memories').get();
    return row === undefined ? 0 : requireNumber(row, 'c');
  }

  close(): void {
    this.db.close();
  }
}
