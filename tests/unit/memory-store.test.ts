/**
 * MemoryStore 单元测试。
 * 锚定的设计承诺（对应 memory/store.ts 文件头）：
 *   - 写入即事实：write 返回完整记录（id/createdAt 由存储层生成，可注入）；
 *   - 跨会话记忆只存 fact / preference 两类；
 *   - list 最近优先、可按 kind 过滤与 limit 截断；
 *   - 空内容拒绝（input_error）；sourceSessionId 可空；
 *   - 与 SessionStore 共享同一数据库文件（表名命名空间隔离）。
 */

import { describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MemoryStore } from '../../src/memory/store.ts';
import { SessionStore } from '../../src/session/store.ts';
import { userMessage } from '../../src/types.ts';

// ---------------------------------------------------------------------------
// 测试装置
// ---------------------------------------------------------------------------

/** 递增固定时钟 + 确定性 id 序列（断言「最近优先」排序与 id 前缀） */
function makeStore(): MemoryStore {
  let tick = 1_700_000_000_000;
  let seq = 0;
  return new MemoryStore(':memory:', {
    now: () => (tick += 1),
    generateId: () => `m_test_${(seq += 1)}`,
  });
}

// ---------------------------------------------------------------------------
// write / list
// ---------------------------------------------------------------------------

describe('MemoryStore 读写', () => {
  it('write 返回完整记录：可注入 id、kind、内容、来源会话、时间戳', () => {
    const store = makeStore();
    const record = store.write({
      kind: 'preference',
      content: '用户偏好简洁的回答',
      sourceSessionId: 's1',
    });
    expect(record.id).toBe('m_test_1');
    expect(record.kind).toBe('preference');
    expect(record.content).toBe('用户偏好简洁的回答');
    expect(record.sourceSessionId).toBe('s1');
    expect(record.createdAt).toBeGreaterThan(1_700_000_000_000);
  });

  it('sourceSessionId 可空：undefined 往返仍为 undefined（NULL 转换）', () => {
    const store = makeStore();
    store.write({ kind: 'fact', content: '系统预置事实' });
    expect(store.list()[0]?.sourceSessionId).toBeUndefined();
  });

  it('空内容拒绝写入（input_error）', () => {
    const store = makeStore();
    expect(() => store.write({ kind: 'fact', content: '   ' })).toThrowError(/记忆内容为空/);
    expect(store.count()).toBe(0);
  });

  it('list 最近优先（写入顺序的倒序）', () => {
    const store = makeStore();
    store.write({ kind: 'fact', content: '第一条' });
    store.write({ kind: 'fact', content: '第二条' });
    store.write({ kind: 'fact', content: '第三条' });
    expect(store.list().map((r) => r.content)).toEqual(['第三条', '第二条', '第一条']);
  });

  it('list 按 kind 过滤 + limit 截断', () => {
    const store = makeStore();
    store.write({ kind: 'fact', content: 'f1' });
    store.write({ kind: 'preference', content: 'p1' });
    store.write({ kind: 'fact', content: 'f2' });
    store.write({ kind: 'preference', content: 'p2' });

    expect(store.list({ kind: 'preference' }).map((r) => r.content)).toEqual(['p2', 'p1']);
    expect(store.list({ kind: 'fact', limit: 1 }).map((r) => r.content)).toEqual(['f2']);
    expect(store.list({ limit: 2 })).toHaveLength(2);
  });

  it('count 统计：总量与按 kind 分类', () => {
    const store = makeStore();
    store.write({ kind: 'fact', content: 'f1' });
    store.write({ kind: 'preference', content: 'p1' });
    expect(store.count()).toBe(2);
    expect(store.count('fact')).toBe(1);
    expect(store.count('preference')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 与 SessionStore 共享同一数据库文件
// ---------------------------------------------------------------------------

describe('共享数据库文件（session 域 + memory 域）', () => {
  it('两个 Store 同文件共存：会话表与记忆表互不干扰，重开后可读', () => {
    const dbPath = join(tmpdir(), `harness-lab-memory-${randomUUID()}.db`);
    try {
      const sessions = new SessionStore(dbPath);
      const memories = new MemoryStore(dbPath);
      sessions.createSession('s1');
      sessions.commit({
        sessionId: 's1',
        deltaMessages: [userMessage('你好')],
        checkpoint: undefined,
        state: undefined,
        keepLast: 3,
      });
      const record = memories.write({
        kind: 'fact',
        content: '共享文件里的记忆',
        sourceSessionId: 's1',
      });

      expect(sessions.getSession('s1')?.messageCount).toBe(1);
      expect(memories.list()[0]?.id).toBe(record.id);
      sessions.close();
      memories.close();

      // 重开：两个域的数据都在（关闭连接后再验证一次持久化）
      const reopenedSessions = new SessionStore(dbPath);
      const reopenedMemories = new MemoryStore(dbPath);
      expect(reopenedSessions.loadMessages('s1')).toHaveLength(1);
      expect(reopenedMemories.count()).toBe(1);
      reopenedSessions.close();
      reopenedMemories.close();
    } finally {
      for (const suffix of ['', '-wal', '-shm']) {
        rmSync(`${dbPath}${suffix}`, { force: true });
      }
    }
  });
});
