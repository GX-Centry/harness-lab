/**
 * SessionStore 与相关工具单元测试（全部使用 :memory: 内存库——零文件副作用）。
 * 锚定的决策（对应 store.ts 文件头「一致性模型」）：
 *   - resolveStorePath：相对路径锚定仓库根（找 package.json），绝不依赖 cwd；
 *   - commit 是唯一写入口：消息 + 检查点 + 状态在一个事务内原子完成；
 *   - keepLast 滚动裁剪：每会话只保留最近 N 个检查点；
 *   - decodeMessage：持久化数据的廉价防线（role 合法性 + 必填字段类型）。
 */

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { SessionStore, decodeMessage, resolveStorePath } from '../../src/session/store.ts';
import { assistantMessage, systemMessage, toolMessage, userMessage } from '../../src/types.ts';
import type { Message, ToolCall } from '../../src/types.ts';

// ---------------------------------------------------------------------------
// 测试装置
// ---------------------------------------------------------------------------

/** 递增固定时钟：保证「后写者更新」的排序可预期（不依赖真实时间） */
function makeClock(): () => number {
  let tick = 1_700_000_000_000;
  return () => (tick += 1);
}

function makeStore(): SessionStore {
  return new SessionStore(':memory:', { now: makeClock() });
}

function call(id: string, name: string): ToolCall {
  return { id, name, args: { k: 'v' }, argsRaw: '{"k":"v"}' };
}

// ---------------------------------------------------------------------------
// resolveStorePath：路径锚定
// ---------------------------------------------------------------------------

describe('resolveStorePath', () => {
  it(':memory: 直通', () => {
    expect(resolveStorePath(':memory:')).toBe(':memory:');
  });

  it('绝对路径直通', () => {
    const absolute = join(process.cwd(), 'whatever.db');
    expect(resolveStorePath(absolute)).toBe(absolute);
  });

  it('相对路径锚定仓库根（而非 cwd）：上级能找到 package.json', () => {
    const resolved = resolveStorePath('data/harness.db');
    expect(isAbsolute(resolved)).toBe(true);
    expect(resolved.endsWith(join('data', 'harness.db'))).toBe(true);
    // <根>/data/harness.db → 上溯两级即仓库根（package.json 在此）
    expect(existsSync(join(dirname(dirname(resolved)), 'package.json'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 会话元数据
// ---------------------------------------------------------------------------

describe('会话元数据', () => {
  it('createSession → getSession 可读（created 状态、消息计数 0）', () => {
    const store = makeStore();
    store.createSession('s1');
    const info = store.getSession('s1');
    expect(info?.state).toBe('created');
    expect(info?.messageCount).toBe(0);
  });

  it('getSession 不存在 → undefined', () => {
    const store = makeStore();
    expect(store.getSession('nope')).toBeUndefined();
  });

  it('重复 id 创建 → 抛错（input_error）', () => {
    const store = makeStore();
    store.createSession('s1');
    expect(() => store.createSession('s1')).toThrowError(/创建会话失败/);
  });

  it('updateState 生效；不存在的会话 → 抛错', () => {
    const store = makeStore();
    store.createSession('s1');
    store.updateState('s1', 'processing');
    expect(store.getSession('s1')?.state).toBe('processing');
    expect(() => store.updateState('nope', 'completed')).toThrowError(/不存在/);
  });

  it('listSessions 按最近更新倒序', () => {
    const store = makeStore();
    store.createSession('s1');
    store.createSession('s2');
    store.updateState('s1', 'processing'); // s1 后更新 → 应排前
    const ids = store.listSessions().map((s) => s.id);
    expect(ids).toEqual(['s1', 's2']);
  });
});

// ---------------------------------------------------------------------------
// 消息与检查点（commit 原子写）
// ---------------------------------------------------------------------------

describe('commit：消息与检查点', () => {
  it('消息追加往返：四种角色的字段完整保持、顺序保持', () => {
    const store = makeStore();
    store.createSession('s1');
    const messages: Message[] = [
      systemMessage('系统'),
      userMessage('问题'),
      assistantMessage('', [call('c1', 'echo')]),
      toolMessage('c1', 'echo', '结果'),
      assistantMessage('回答'),
    ];
    store.commit({
      sessionId: 's1',
      deltaMessages: messages,
      checkpoint: undefined,
      state: undefined,
      keepLast: 3,
    });
    expect(store.loadMessages('s1')).toEqual(messages);
    expect(store.getSession('s1')?.messageCount).toBe(5);
  });

  it('检查点往返：turn 与快照消息可读；无检查点 → undefined', () => {
    const store = makeStore();
    store.createSession('s1');
    const snapshot: Message[] = [systemMessage('s'), userMessage('u')];
    store.commit({
      sessionId: 's1',
      deltaMessages: snapshot,
      checkpoint: { id: 'cp1', turn: 1, messages: snapshot },
      state: 'processing',
      keepLast: 3,
    });
    const latest = store.loadLatestCheckpoint('s1');
    expect(latest?.id).toBe('cp1');
    expect(latest?.turn).toBe(1);
    expect(latest?.messages).toEqual(snapshot);
    // 另一个会话无检查点
    store.createSession('s2');
    expect(store.loadLatestCheckpoint('s2')).toBeUndefined();
  });

  it('commit 可携带状态迁移（终结原子提交的用法）', () => {
    const store = makeStore();
    store.createSession('s1');
    store.commit({
      sessionId: 's1',
      deltaMessages: [userMessage('u')],
      checkpoint: undefined,
      state: 'completed',
      keepLast: 3,
    });
    expect(store.getSession('s1')?.state).toBe('completed');
  });

  it('keepLast 滚动裁剪：只保留最近 N 个检查点', () => {
    const store = makeStore();
    store.createSession('s1');
    for (let turn = 1; turn <= 5; turn += 1) {
      const messages: Message[] = [userMessage(`第 ${turn} 轮`)];
      store.commit({
        sessionId: 's1',
        deltaMessages: [],
        checkpoint: { id: `cp${turn}`, turn, messages },
        state: undefined,
        keepLast: 2,
      });
    }
    expect(store.countCheckpoints('s1')).toBe(2);
    expect(store.loadLatestCheckpoint('s1')?.turn).toBe(5); // 最新保留
  });

  it('外键保护：对不存在的会话 commit → 抛错并回滚', () => {
    const store = makeStore();
    expect(() =>
      store.commit({
        sessionId: 'ghost',
        deltaMessages: [userMessage('u')],
        checkpoint: undefined,
        state: undefined,
        keepLast: 3,
      }),
    ).toThrowError(/事务失败/);
  });
});

// ---------------------------------------------------------------------------
// decodeMessage：反序列化的廉价防线
// ---------------------------------------------------------------------------

describe('decodeMessage', () => {
  it('四种角色往返', () => {
    const cases: Message[] = [
      systemMessage('s'),
      userMessage('u'),
      assistantMessage('无调用'),
      assistantMessage('', [call('c1', 'echo')]),
      toolMessage('c1', 'echo', 'r'),
    ];
    for (const message of cases) {
      expect(decodeMessage(JSON.stringify(message))).toEqual(message);
    }
  });

  it('非法输入 → 抛错（非对象 / 非法 role / content 缺失 / tool 缺字段）', () => {
    expect(() => decodeMessage('42')).toThrowError(/不是 JSON 对象/);
    expect(() => decodeMessage('{"role":"alien","content":"x"}')).toThrowError(/role 非法/);
    expect(() => decodeMessage('{"role":"user"}')).toThrowError(/content/);
    expect(() => decodeMessage('{"role":"tool","content":"x"}')).toThrowError(/toolCallId/);
  });
});
