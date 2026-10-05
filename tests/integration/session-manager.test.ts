/**
 * SessionManager 集成测试 —— 会话生命周期 / 持久化 / 崩溃恢复的端到端验证。
 *
 * 覆盖矩阵（对齐 session-manager.ts 文件头的「三条写入纪律」）：
 *   ① query 闭环：Loop 事件透传 + 消息与状态原子落盘 + 事件序列完整；
 *   ② 多轮对话：历史累积、system 不重复注入、状态回 completed；
 *   ③ 崩溃恢复：残留 processing + pending 调用 → resume 补位（幂等）→ 可继续；
 *   ④ 优雅取消：abort → interrupted（Loop 取消协议已补位）→ resume 确认；
 *   ⑤ 并发保护、checkpoint 模式（manual/every_turn/after_tool 降级）、keepLast 裁剪；
 *   ⑥ 错误面：会话不存在 / 无检查点 / completed 不适用恢复。
 *
 * 存储使用 :memory:（每个 fixture 独立世界，零文件副作用）。
 */

import { describe, expect, it } from 'vitest';
import { defineConfig } from '../../src/config.ts';
import { AgentLoop } from '../../src/kernel/agent-loop.ts';
import type { LoopEvent, LoopResult } from '../../src/kernel/agent-loop.ts';
import { Dispatcher } from '../../src/kernel/dispatcher.ts';
import type { HarnessEvent } from '../../src/kernel/events.ts';
import { EventBus } from '../../src/kernel/events.ts';
import { FakeProvider } from '../../src/llm/fake-provider.ts';
import type { FakeTurn } from '../../src/llm/fake-provider.ts';
import { HookPipeline } from '../../src/hooks/pipeline.ts';
import { PermissionGate } from '../../src/permission/gate.ts';
import { SessionManager } from '../../src/session/session-manager.ts';
import { SessionStore } from '../../src/session/store.ts';
import { echoTool } from '../../src/tools/builtin/index.ts';
import { ToolRegistry } from '../../src/tools/registry.ts';
import type { Message, ToolCall } from '../../src/types.ts';
import { assistantMessage, userMessage } from '../../src/types.ts';

// ---------------------------------------------------------------------------
// 测试装置
// ---------------------------------------------------------------------------

interface ManagerFixture {
  readonly manager: SessionManager;
  readonly store: SessionStore;
  readonly bus: EventBus;
  readonly events: HarnessEvent[];
}

interface FixtureOptions {
  readonly maxTurns?: number;
  readonly checkpointMode?: 'every_turn' | 'after_tool' | 'manual';
  readonly keepLast?: number;
}

function makeFixture(script: readonly FakeTurn[], options: FixtureOptions = {}): ManagerFixture {
  const config = defineConfig({
    ...(options.maxTurns !== undefined ? { loop: { maxTurns: options.maxTurns } } : {}),
    session: {
      checkpoint: {
        mode: options.checkpointMode ?? 'every_turn',
        keepLast: options.keepLast ?? 3,
      },
    },
  });

  // 递增固定时钟（store 与 manager 共享同一时间线）
  let tick = 1_700_000_000_000;
  const clock = (): number => (tick += 1);

  const registry = new ToolRegistry();
  registry.register(echoTool);
  const bus = new EventBus();
  const events: HarnessEvent[] = [];
  bus.on('*', (event) => events.push(event));

  const hooks = new HookPipeline({ hooks: [], bus });
  const permission = new PermissionGate({ config: config.permission });
  const dispatcher = new Dispatcher({ registry, hooks, permission, bus, config });
  const provider = new FakeProvider({ script });
  const loop = new AgentLoop({
    provider,
    dispatcher,
    registry,
    bus,
    config,
    systemPrompt: '测试 system',
  });
  const store = new SessionStore(':memory:', { now: clock });
  const manager = new SessionManager({
    store,
    loop,
    bus,
    config,
    workingDir: process.cwd(),
  });
  return { manager, store, bus, events };
}

function sig(): AbortSignal {
  return new AbortController().signal;
}

/** 消费整个事件流并提取终态（与 agent-loop.test.ts 同款消费方式） */
async function collect(
  gen: AsyncGenerator<LoopEvent, LoopResult, void>,
  onEvent?: (event: LoopEvent) => void,
): Promise<{ events: LoopEvent[]; result: LoopResult }> {
  const events: LoopEvent[] = [];
  let result: LoopResult | undefined;
  for await (const event of gen) {
    onEvent?.(event);
    events.push(event);
    if (event.type === 'completed') result = event.result;
  }
  if (result === undefined) {
    throw new Error('SessionManager.runQuery 未产出 completed 终态信封');
  }
  return { events, result };
}

function toolCall(callId: string, message: string): ToolCall {
  return { id: callId, name: 'echo', args: { message }, argsRaw: JSON.stringify({ message }) };
}

// ---------------------------------------------------------------------------
// ① query 闭环：落盘 + 事件
// ---------------------------------------------------------------------------

describe('runQuery 闭环', () => {
  it('消息与状态原子落盘；事件序列完整（created → processing → completed）', async () => {
    const fx = makeFixture([
      { text: '调用工具', toolCalls: [{ name: 'echo', args: { message: 'hi' } }] },
      { text: '完成' },
    ]);
    expect(fx.manager.createSession('s1').state).toBe('created');

    const { result } = await collect(fx.manager.runQuery('s1', '你好', sig()));

    expect(result.stopReason).toBe('completed');
    // system(注入) + user + assistant(调用) + tool + assistant = 5
    expect(result.messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    // 落盘内容与 LoopResult 完全一致（同一份事实）
    expect(fx.store.loadMessages('s1')).toEqual(result.messages);
    expect(fx.manager.getSession('s1')?.state).toBe('completed');
    expect(fx.manager.getSession('s1')?.messageCount).toBe(5);

    // ---- 事件序列 ----
    expect(fx.events[0]?.type).toBe('session_created');
    const stateChanges = fx.events
      .filter((e) => e.type === 'session_state_change')
      .map((e) => `${e.from}->${e.to}`);
    expect(stateChanges).toEqual(['created->processing', 'processing->completed']);
    expect(fx.events.filter((e) => e.type === 'message_persisted').length).toBe(5);
    // 检查点：turn1（中间轮）+ turn2（终结）；终结快照含全部 5 条
    const checkpointTurns = fx.events
      .filter((e) => e.type === 'checkpoint_saved')
      .map((e) => e.turn);
    expect(checkpointTurns).toEqual([1, 2]);
    expect(fx.store.loadLatestCheckpoint('s1')?.messages.length).toBe(5);
  });

  it('同一会话第二次 query：历史累积、system 不重复注入', async () => {
    const fx = makeFixture([{ text: '第一答' }, { text: '第二答' }]);
    fx.manager.createSession('s1');

    const r1 = await collect(fx.manager.runQuery('s1', '第一问', sig()));
    expect(r1.result.messages.length).toBe(3);

    const r2 = await collect(fx.manager.runQuery('s1', '第二问', sig()));
    expect(r2.result.messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(fx.store.loadMessages('s1').length).toBe(5);
    expect(fx.manager.getSession('s1')?.state).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// ② 崩溃恢复（checkpoint 路径）
// ---------------------------------------------------------------------------

describe('崩溃恢复', () => {
  it('残留 processing + pending 调用 → resume 补位（幂等）→ 可继续提问', async () => {
    const fx = makeFixture([{ text: '恢复后继续答' }]);
    fx.manager.createSession('s1');

    // 模拟「上次进程在工具执行中被杀」：绕过 manager 直接写入崩溃点状态
    // （processing + assistant 宣布了 c1 但无任何 tool 结果）
    const crashMessages: Message[] = [
      userMessage('帮我回显 42'),
      assistantMessage('', [toolCall('c1', '42')]),
    ];
    fx.store.commit({
      sessionId: 's1',
      deltaMessages: crashMessages,
      checkpoint: { id: 'cp-crash', turn: 1, messages: crashMessages },
      state: 'processing',
      keepLast: 3,
    });

    const resume = fx.manager.resumeSession('s1');
    expect(resume.checkpointId).toBe('cp-crash');
    expect(resume.filledToolCallIds).toEqual(['c1']);
    expect(resume.messageCount).toBe(3); // 崩溃点 2 条 + 补位 1 条
    // 崩溃残留的 processing → 显式标记 interrupted
    expect(fx.manager.getSession('s1')?.state).toBe('interrupted');
    const persisted = fx.store.loadMessages('s1');
    expect(persisted.length).toBe(3);
    expect(persisted[2]?.role).toBe('tool');

    // 幂等：二次恢复不重复补位
    const again = fx.manager.resumeSession('s1');
    expect(again.filledToolCallIds).toEqual([]);
    expect(fx.store.loadMessages('s1').length).toBe(3);

    // 恢复后可继续提问（interrupted 状态允许 runQuery）
    const { result } = await collect(fx.manager.runQuery('s1', '那再算一下', sig()));
    expect(result.stopReason).toBe('completed');
    // system(注入) + 崩溃 2 条 + 补位 1 条 + user + assistant = 6
    expect(result.messages.length).toBe(6);
    expect(fx.events.filter((e) => e.type === 'session_resumed').length).toBe(2);
  });

  it('优雅取消（工具执行中 abort）：Loop 已补位、状态 interrupted；resume 确认无缺口', async () => {
    const fx = makeFixture([{ text: '开工', toolCalls: [{ name: 'echo', args: { message: 'x' } }] }]);
    fx.manager.createSession('s1');
    const controller = new AbortController();

    const { result } = await collect(
      fx.manager.runQuery('s1', '任务', controller.signal),
      (event) => {
        if (event.type === 'tool_started') controller.abort();
      },
    );

    expect(result.stopReason).toBe('aborted');
    expect(fx.manager.getSession('s1')?.state).toBe('interrupted');
    // 取消协议（agent-loop 决策 ⑤）已补齐配对：最后一条是占位 tool 消息
    const persisted = fx.store.loadMessages('s1');
    const last = persisted[persisted.length - 1];
    expect(last?.role).toBe('tool');
    if (last?.role !== 'tool') throw new Error('最后一条应为 tool 占位');
    expect(last.content).toContain('取消');

    // resume：无缺失（取消路径已完成闭环）——但恢复流程本身仍完整执行
    const resume = fx.manager.resumeSession('s1');
    expect(resume.filledToolCallIds).toEqual([]);
  });

  it('无检查点的会话：resume 拒绝（无从恢复）', () => {
    const fx = makeFixture([{ text: '答' }]);
    fx.manager.createSession('s1');
    fx.store.updateState('s1', 'interrupted'); // 无任何检查点
    expect(() => fx.manager.resumeSession('s1')).toThrowError(/无检查点/);
  });
});

// ---------------------------------------------------------------------------
// ③ 并发保护与错误面
// ---------------------------------------------------------------------------

describe('并发与错误面', () => {
  it('同一会话并发 query → 拒绝；前一条正常收尾', async () => {
    const fx = makeFixture([{ text: '慢答' }]);
    fx.manager.createSession('s1');
    const signal = sig();

    const gen = fx.manager.runQuery('s1', '第一问', signal);
    await gen.next(); // 启动：进入 running 集合

    await expect(collect(fx.manager.runQuery('s1', '并发问', signal))).rejects.toThrowError(/并发/);

    const { result } = await collect(gen); // 收尾
    expect(result.stopReason).toBe('completed');
  });

  it('会话不存在：runQuery / resumeSession 均抛错', async () => {
    const fx = makeFixture([{ text: '答' }]);
    await expect(collect(fx.manager.runQuery('ghost', 'x', sig()))).rejects.toThrowError(/不存在/);
    expect(() => fx.manager.resumeSession('ghost')).toThrowError(/不存在/);
  });

  it('completed 会话不适用恢复流程（直接继续提问即可）', async () => {
    const fx = makeFixture([{ text: '答' }]);
    fx.manager.createSession('s1');
    await collect(fx.manager.runQuery('s1', '问', sig()));
    expect(() => fx.manager.resumeSession('s1')).toThrowError(/无需恢复/);
  });
});

// ---------------------------------------------------------------------------
// ④ checkpoint 模式与裁剪
// ---------------------------------------------------------------------------

describe('checkpoint 模式', () => {
  const twoToolScript: FakeTurn[] = [
    { text: '第一步', toolCalls: [{ name: 'echo', args: { message: '1' } }] },
    { text: '第二步', toolCalls: [{ name: 'echo', args: { message: '2' } }] },
    { text: '完成' },
  ];

  it('manual 仅终结存一次；every_turn 每个一致点都存（对照）', async () => {
    const manualFx = makeFixture(twoToolScript, { checkpointMode: 'manual' });
    manualFx.manager.createSession('s1');
    const manualResult = await collect(manualFx.manager.runQuery('s1', '任务', sig()));
    expect(manualResult.result.turns).toBe(3);
    expect(manualFx.store.countCheckpoints('s1')).toBe(1);
    expect(manualFx.store.loadLatestCheckpoint('s1')?.turn).toBe(3);

    const everyFx = makeFixture(twoToolScript, { checkpointMode: 'every_turn' });
    everyFx.manager.createSession('s1');
    await collect(everyFx.manager.runQuery('s1', '任务', sig()));
    // turn1、turn2 中间轮 + turn3 终结 = 3 个一致点
    expect(everyFx.store.countCheckpoints('s1')).toBe(3);
  });

  it('keepLast 滚动裁剪：检查点数量封顶', async () => {
    const fx = makeFixture(
      [
        { text: 'a', toolCalls: [{ name: 'echo', args: { message: '1' } }] },
        { text: 'b', toolCalls: [{ name: 'echo', args: { message: '2' } }] },
        { text: 'c', toolCalls: [{ name: 'echo', args: { message: '3' } }] },
        { text: '完成' },
      ],
      { keepLast: 2 },
    );
    fx.manager.createSession('s1');
    await collect(fx.manager.runQuery('s1', '任务', sig()));
    // 4 个一致点（turn1-3 中间 + turn4 终结）→ 保留最近 2
    expect(fx.store.countCheckpoints('s1')).toBe(2);
    expect(fx.store.loadLatestCheckpoint('s1')?.turn).toBe(4);
  });

  it('after_tool 模式：显式降级警告（不静默忽略）', () => {
    const fx = makeFixture([{ text: '答' }], { checkpointMode: 'after_tool' });
    const logs = fx.events.filter((e) => e.type === 'log');
    const warn = logs.find((e) => e.level === 'warn');
    expect(warn?.message).toContain('降级');
  });
});
