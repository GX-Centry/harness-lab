/**
 * SessionStore —— 会话域的持久化层（SQLite，node:sqlite 内置驱动）。
 *
 * 为什么用 node:sqlite 而不是 better-sqlite3（ADR-006）：
 *   零原生依赖、零安装成本（Node 22.5+ 内置）——教学项目优先「开箱即跑」，
 *   避免 node-gyp / 预编译二进制在新 Node 版本上的缺件风险。
 *   代价：无扩展生态；API 是同步的（DatabaseSync）——同步反而与
 *   「快照回调必须同步消费完毕」的 Loop 接缝天然契合（见 agent-loop 决策 ⑥）。
 *
 * 一致性模型（本文件最重要的设计，先读这里）：
 *   - **唯一写入口 commit()**：消息差量 + 检查点快照（可选）+ 状态（可选）
 *     在**同一个事务**里原子完成；
 *   - 由此得到不变式：「每次 commit 之后，messages 表的内容 == 最近检查点的
 *     messages 快照」。崩溃只能落在两次 commit 之间的间隙——数据库永远
 *     停留在某个「一致点」，不存在「消息写入一半」或「快照领先/落后消息表」
 *     的中间态；
 *   - 「数据先行、状态殿后」纪律：调用方（SessionManager）先 commit 数据、
 *     再 migration 状态；若崩溃在两者之间，恢复流程按「状态未更新」处理，
 *     结果是安全的（最多多做一次占位/重复检查，幂等）。
 *
 * 表结构（三张，DDL 幂等）：
 *   sessions    —— 会话元数据（状态机状态 + 时间戳）
 *   messages    —— 追加式消息日志（payload 为规范形消息的 JSON）
 *   checkpoints —— 自包含快照（turn + messages JSON；冗余但恢复一次读齐）
 *
 * 「共享存储层」的 v1 边界（对齐 01-architecture §2 要点）：
 *   本文件的 openDatabase()/DDL 辅助是「session/memory/permission 共享同一
 *   SQLite」的第一块砖。暂不为『共享』单开 src/store/ 目录——只有一个消费
 *   域时先集中讲清楚；w11 Memory 表将加入同一数据库文件（复用本文件的
 *   打开与迁移辅助）。第三个域出现时再提炼公共模块（架构演进点）。
 *
 * 依赖方向：session/store.ts → node:sqlite / node:fs / node:path / node:url
 *           + errors（不依赖 bus——事件上报是 SessionManager 的职责，
 *           存储层保持「哑」——可被单测与未来的迁移工具直接使用）。
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';
import { HarnessError } from '../errors.ts';
import type { Message, SessionState, ToolCall } from '../types.ts';

// ===========================================================================
// §1 路径解析（绝不依赖进程 cwd —— SessionConfig.storePath 的注释承诺）
// ===========================================================================

/**
 * 把配置里的存储路径解析为可用于打开数据库的路径：
 *   - ':memory:'：测试专用内存库，直通；
 *   - 绝对路径：直通；
 *   - 相对路径：**相对仓库根目录**（而不是 process.cwd()）解析——
 *     「在哪个目录启动进程」不应该改变数据的存放位置。
 *
 * 仓库根的定位方式：从本文件位置（import.meta.url）向上逐级找 package.json。
 * 为什么不用「上溯 N 级」的固定层数：源码（src/session/）与构建产物
 * （dist/session/）的层数虽然恰好一致，但固定层数一旦重构目录就会静默错位；
 * 「找 package.json」是自描述锚点，重构不改语义。
 */
export function resolveStorePath(storePath: string): string {
  if (storePath === ':memory:' || isAbsolute(storePath)) {
    return storePath;
  }
  let dir = fileURLToPath(new URL('.', import.meta.url));
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) {
      return join(dir, storePath);
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new HarnessError(
        'config_error',
        `无法定位仓库根目录：从 ${import.meta.url} 上溯未找到 package.json`,
        { where: 'session/store' },
      );
    }
    dir = parent;
  }
}

// ===========================================================================
// §2 行转换与消息解码（SQLite 弱类型边界的收窄现场）
// ===========================================================================

/** SQL 查询回来的行（node:sqlite 的宽泛行类型） */
type SqlRow = Record<string, string | number | bigint | Uint8Array | null>;

function requireString(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new HarnessError(
      'internal_error',
      `存储列 ${column} 类型异常（期望 string，实得 ${typeof value}）——数据可能被外部破坏`,
      { where: 'session/store' },
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
    `存储列 ${column} 类型异常（期望 number，实得 ${typeof value}）——数据可能被外部破坏`,
    { where: 'session/store' },
  );
}

const SESSION_STATES: readonly SessionState[] = [
  'created',
  'processing',
  'completed',
  'failed',
  'interrupted',
];

function requireState(row: SqlRow, column: string): SessionState {
  const value = requireString(row, column);
  const state = SESSION_STATES.find((candidate) => candidate === value);
  if (state === undefined) {
    throw new HarnessError('internal_error', `存储列 ${column} 含非法会话状态：${value}`, {
      where: 'session/store',
    });
  }
  return state;
}

/**
 * 反序列化一条规范形消息（持久化数据的廉价防线）。
 * 校验：role 合法性 + 各角色必填字段的类型。
 * 取舍：toolCalls 数组的**逐项**深校验暂不做（自产数据 + JSON 完整性由
 *      写路径保证）；接入外部数据源前应升级为 zod schema 校验。
 * 断言说明：守卫已收窄到「形状可信」，`as Message` 是进类型系统的桥。
 */
export function decodeMessage(payload: string): Message {
  const raw: unknown = JSON.parse(payload);
  if (typeof raw !== 'object' || raw === null) {
    throw new HarnessError('internal_error', '消息 payload 不是 JSON 对象', {
      where: 'session/store',
    });
  }
  const record = raw as Record<string, unknown>;
  const role = record['role'];
  const content = record['content'];
  if (typeof content !== 'string') {
    throw new HarnessError('internal_error', `消息 content 缺失或非字符串（role=${String(role)}）`, {
      where: 'session/store',
    });
  }
  switch (role) {
    case 'system':
      return { role, content };
    case 'user':
      return { role, content };
    case 'assistant': {
      const toolCalls = record['toolCalls'];
      if (toolCalls === undefined) return { role, content };
      if (!Array.isArray(toolCalls)) {
        throw new HarnessError('internal_error', 'assistant.toolCalls 不是数组', {
          where: 'session/store',
        });
      }
      return { role, content, toolCalls: toolCalls as readonly ToolCall[] };
    }
    case 'tool': {
      const toolCallId = record['toolCallId'];
      const name = record['name'];
      if (typeof toolCallId !== 'string' || typeof name !== 'string') {
        throw new HarnessError('internal_error', 'tool 消息缺少 toolCallId / name', {
          where: 'session/store',
        });
      }
      return { role, content, toolCallId, name };
    }
    default:
      throw new HarnessError('internal_error', `消息 role 非法：${String(role)}`, {
        where: 'session/store',
      });
  }
}

// ===========================================================================
// §3 行形状与提交输入
// ===========================================================================

/** 会话元数据（含消息计数——/status 与测试的可视化字段） */
export interface SessionRow {
  readonly id: string;
  readonly state: SessionState;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly messageCount: number;
}

/** 检查点快照（自包含：一次读齐即可恢复） */
export interface CheckpointRow {
  readonly id: string;
  readonly sessionId: string;
  readonly turn: number;
  readonly messages: readonly Message[];
  readonly createdAt: number;
}

/** 提交检查点的输入（id 由调用方生成——可注入的确定性来自调用方） */
export interface CheckpointInput {
  readonly id: string;
  readonly turn: number;
  readonly messages: readonly Message[];
}

/** commit() 的输入：一次原子写入的全部素材 */
export interface CommitInput {
  readonly sessionId: string;
  /** 消息差量（通常为「上次提交之后新增」的消息；空数组合法） */
  readonly deltaMessages: readonly Message[];
  /** 检查点快照；undefined = 本次不存检查点（manual 模式的中间轮） */
  readonly checkpoint: CheckpointInput | undefined;
  /** 会话状态；undefined = 不改状态（中间轮提交不影响状态机） */
  readonly state: SessionState | undefined;
  /** 每会话保留最近 N 个检查点（滚动裁剪，同事务内执行） */
  readonly keepLast: number;
}

// ===========================================================================
// §4 SessionStore
// ===========================================================================

export interface SessionStoreOptions {
  /** 时钟注入（测试固定时钟；默认 Date.now） */
  readonly now?: () => number;
}

/**
 * 打开（必要时创建）一个 SQLite 连接，并完成全局 PRAGMA 设置。
 *
 * 这是「session / memory / permission 共享同一数据库文件」承诺的落地辅助
 * （见文件头 v1 边界说明）：各域 Store（SessionStore / MemoryStore）复用本
 * 函数打开同一文件，各自负责自己表的迁移（表名即命名空间）。
 *
 * PRAGMA 语义：
 *   - WAL：写不阻塞读（REPL 场景下 /history 读取与落盘可并行）；
 *     对 ':memory:' 无害（该 PRAGMA 在内存库上返回 'memory'，不报错）；
 *   - foreign_keys：会话域表间外键（孤儿数据在恢复时是灾难）。
 *
 * 多连接语义：每个 Store 持有自己的 DatabaseSync 连接。node:sqlite 的 API
 * 是同步的——单进程内两个连接的操作在同一调用栈上串行发生，不存在并发
 * 写交错；跨进程并发场景是演进点（锁表），教学项目不涉及。
 */
export function openDatabase(dbPath: string): DatabaseSync {
  // 文件库先确保目录存在（:memory: 无目录概念）
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

export class SessionStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(dbPath: string, options: SessionStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.db = openDatabase(dbPath);
    this.migrate();
  }

  /** DDL 幂等迁移（v1：CREATE IF NOT EXISTS；schema 版本化是演进点） */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id         TEXT PRIMARY KEY,
        state      TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        role       TEXT NOT NULL,
        payload    TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        id         TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        turn       INTEGER NOT NULL,
        payload    TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
      CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id, created_at);
    `);
  }

  // -------------------------------------------------------------------------
  // 会话元数据
  // -------------------------------------------------------------------------

  /** 新建会话（状态 created）。id 重复 → input_error（调用方应改用随机 id） */
  createSession(id: string): void {
    const ts = this.now();
    try {
      this.prepare('INSERT INTO sessions (id, state, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
        id,
        'created',
        ts,
        ts,
      );
    } catch (raw) {
      throw new HarnessError('input_error', `创建会话失败（id 是否重复？）：${id}`, {
        where: 'session/store',
        cause: raw,
      });
    }
  }

  /** 读取会话元数据（含消息计数）；不存在 → undefined */
  getSession(id: string): SessionRow | undefined {
    const row = this.prepare(
      `SELECT s.id, s.state, s.created_at, s.updated_at,
              (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
       FROM sessions s WHERE s.id = ?`,
    ).get(id);
    return row === undefined ? undefined : this.toSessionRow(row);
  }

  /** 全会话列表（按最近更新倒序——CLI 的会话选择器视角） */
  listSessions(): SessionRow[] {
    const rows = this.prepare(
      `SELECT s.id, s.state, s.created_at, s.updated_at,
              (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
       FROM sessions s ORDER BY s.updated_at DESC`,
    ).all();
    return rows.map((row) => this.toSessionRow(row));
  }

  /**
   * 状态迁移（**不走事务**：单条 UPDATE 本身原子）。
   * 「数据先行、状态殿后」纪律的另一半：状态写入永远晚于数据提交。
   */
  updateState(id: string, state: SessionState): void {
    const result = this.prepare('UPDATE sessions SET state = ?, updated_at = ? WHERE id = ?').run(
      state,
      this.now(),
      id,
    );
    if (result.changes === 0) {
      throw new HarnessError('input_error', `更新状态的会话不存在：${id}`, {
        where: 'session/store',
      });
    }
  }

  // -------------------------------------------------------------------------
  // 消息与检查点
  // -------------------------------------------------------------------------

  /** 已持久化的全部消息（按写入顺序 = 对话顺序） */
  loadMessages(sessionId: string): Message[] {
    const rows = this.prepare(
      'SELECT payload FROM messages WHERE session_id = ? ORDER BY id ASC',
    ).all(sessionId);
    return rows.map((row) => decodeMessage(requireString(row, 'payload')));
  }

  /** 最近一个检查点（自包含快照）；无 → undefined */
  loadLatestCheckpoint(sessionId: string): CheckpointRow | undefined {
    const row = this.prepare(
      `SELECT id, session_id, turn, payload, created_at FROM checkpoints
       WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(sessionId);
    if (row === undefined) return undefined;
    const raw = requireString(row, 'payload');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new HarnessError('internal_error', `检查点 payload 不是消息数组（${sessionId}）`, {
        where: 'session/store',
      });
    }
    return {
      id: requireString(row, 'id'),
      sessionId: requireString(row, 'session_id'),
      turn: requireNumber(row, 'turn'),
      messages: parsed as readonly Message[],
      createdAt: requireNumber(row, 'created_at'),
    };
  }

  /** 会话当前保留的检查点数量（可观测面：验证 keepLast 滚动裁剪） */
  countCheckpoints(sessionId: string): number {
    const row = this.prepare('SELECT COUNT(*) AS c FROM checkpoints WHERE session_id = ?').get(
      sessionId,
    );
    return row === undefined ? 0 : requireNumber(row, 'c');
  }

  /**
   * 原子提交：消息差量 + 检查点（可选）+ 状态（可选）+ 检查点滚动裁剪，
   * 全部在一个事务内完成（一致性模型的落地点——见文件头）。
   */
  commit(input: CommitInput): void {
    const ts = this.now();
    this.withTransaction(() => {
      const insertMessage = this.prepare(
        'INSERT INTO messages (session_id, role, payload, created_at) VALUES (?, ?, ?, ?)',
      );
      for (const message of input.deltaMessages) {
        insertMessage.run(input.sessionId, message.role, JSON.stringify(message), ts);
      }

      if (input.checkpoint !== undefined) {
        this.prepare(
          'INSERT INTO checkpoints (id, session_id, turn, payload, created_at) VALUES (?, ?, ?, ?, ?)',
        ).run(
          input.checkpoint.id,
          input.sessionId,
          input.checkpoint.turn,
          JSON.stringify(input.checkpoint.messages),
          ts,
        );
        // 滚动裁剪：只保留最近 keepLast 个（keepLast <= 0 视为 1，防配置误伤）
        this.prepare(
          `DELETE FROM checkpoints
           WHERE session_id = ? AND id NOT IN (
             SELECT id FROM checkpoints WHERE session_id = ?
             ORDER BY created_at DESC, rowid DESC LIMIT ?
           )`,
        ).run(input.sessionId, input.sessionId, Math.max(1, input.keepLast));
      }

      if (input.state !== undefined) {
        this.prepare('UPDATE sessions SET state = ?, updated_at = ? WHERE id = ?').run(
          input.state,
          ts,
          input.sessionId,
        );
      } else {
        // 无状态变化也刷新 updated_at（「最近活动时间」语义）
        this.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(ts, input.sessionId);
      }
    });
  }

  /** 关闭连接（进程退出 / 测试清理；WAL 数据在 close 时落盘收尾） */
  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // 内部实现
  // -------------------------------------------------------------------------

  private prepare(sql: string): StatementSync {
    // v1 每次 prepare（语句数量少、SQLite 编译极快）；
    // 语句缓存（long-lived StatementSync）是明确的性能演进点。
    return this.db.prepare(sql);
  }

  /** 事务包装：BEGIN/COMMIT/ROLLBACK 三件套（v1 不支持嵌套——见 commit 调用面） */
  private withTransaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (raw) {
      this.db.exec('ROLLBACK');
      throw new HarnessError('internal_error', '会话持久化事务失败（已回滚）', {
        where: 'session/store',
        cause: raw,
      });
    }
  }

  private toSessionRow(row: SqlRow): SessionRow {
    return {
      id: requireString(row, 'id'),
      state: requireState(row, 'state'),
      createdAt: requireNumber(row, 'created_at'),
      updatedAt: requireNumber(row, 'updated_at'),
      messageCount: requireNumber(row, 'message_count'),
    };
  }
}
