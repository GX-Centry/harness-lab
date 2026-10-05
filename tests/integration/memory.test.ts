/**
 * 记忆层集成测试 —— MemoryManager / SessionManager / ContextManager 三方联动。
 *
 * 覆盖矩阵（对齐 memory/manager.ts 文件头的三个横切决策）：
 *   ① 触发写入：显式请求 → query 终结后入库 + memory_written 事件；
 *   ② 检索注入：跨会话命中 → <user_profile>/<task_context> 出现在 system；
 *   ③ 短路语义：enabled=false → 不读库不写库不发事件；
 *   ④ 失败隔离：记忆库不可用 → 对话照常完成 + warn 日志；
 *   ⑤ 路径边界：aborted 也触发（信号在输入里）、failed 不触发（异常路径）。
 *
 * 注入的最终证据取 FakeProvider.requests——断言「模型真正收到的 system
 * 长什么样」，而不是中间状态（端到端穿透验证）。
 */

import { describe, expect, it } from 'vitest';
import { defineConfig } from '../../src/config.ts';
import { ContextManager } from '../../src/context/manager.ts';
import { AgentLoop } from '../../src/kernel/agent-loop.ts';
import type { LoopEvent, LoopResult } from '../../src/kernel/agent-loop.ts';
import { Dispatcher } from '../../src/kernel/dispatcher.ts';
import type { HarnessEvent } from '../../src/kernel/events.ts';
import { EventBus } from '../../src/kernel/events.ts';
import { FakeProvider } from '../../src/llm/fake-provider.ts';
import type { FakeTurn } from '../../src/llm/fake-provider.ts';
import { HookPipeline } from '../../src/hooks/pipeline.ts';
import { MemoryManager } from '../../src/memory/manager.ts';
import { MemoryStore } from '../../src/memory/store.ts';
import { PermissionGate } from '../../src/permission/gate.ts';
import { SessionManager } from '../../src/session/session-manager.ts';
import { SessionStore } from '../../src/session/store.ts';
import { echoTool } from '../../src/tools/builtin/index.ts';
import { ToolRegistry } from '../../src/tools/registry.ts';

// ---------------------------------------------------------------------------
// 测试装置
// ---------------------------------------------------------------------------

interface MemoryFixture {
  readonly manager: SessionManager;
  readonly memoryStore: MemoryStore;
  readonly bus: EventBus;
  readonly events: HarnessEvent[];
  readonly provider: FakeProvider;
}

function makeFixture(
  script: readonly FakeTurn[],
  options: { readonly memoryEnabled?: boolean } = {},
): MemoryFixture {
  const config = defineConfig({
    ...(options.memoryEnabled !== undefined ? { memory: { enabled: options.memoryEnabled } } : {}),
  });

  // 递增固定时钟（会话库与记忆库共享同一时间线）
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
  // ContextManager 是注入链路的必经环节：没有它，injections 在直传模式下
  // 会被静默忽略（本夹具的早期版本就漏了这一环——测试当场抓出）
  const contextManager = new ContextManager({
    config: config.context,
    count: (text) => provider.countTokens(text),
    bus,
  });
  const loop = new AgentLoop({
    provider,
    dispatcher,
    registry,
    bus,
    config,
    contextManager,
    systemPrompt: '测试 system',
  });
  const sessionStore = new SessionStore(':memory:', { now: clock });
  const memoryStore = new MemoryStore(':memory:', { now: clock });
  const memoryManager = new MemoryManager({ store: memoryStore, config: config.memory, bus });
  const manager = new SessionManager({
    store: sessionStore,
    loop,
    bus,
    config,
    workingDir: process.cwd(),
    memory: memoryManager,
  });
  return { manager, memoryStore, bus, events, provider };
}

function sig(): AbortSignal {
  return new AbortController().signal;
}

/** 消费事件流并提取终态（同款消费方式） */
async function collect(
  gen: AsyncGenerator<LoopEvent, LoopResult, void>,
): Promise<{ events: LoopEvent[]; result: LoopResult }> {
  const events: LoopEvent[] = [];
  let result: LoopResult | undefined;
  for await (const event of gen) {
    events.push(event);
    if (event.type === 'completed') result = event.result;
  }
  if (result === undefined) {
    throw new Error('runQuery 未产出 completed 终态信封');
  }
  return { events, result };
}

/** 取第 n 次 LLM 请求的 system 消息内容（注入证据） */
function systemOf(f: MemoryFixture, requestIndex: number): string {
  const request = f.provider.requests[requestIndex];
  const system = request?.messages[0];
  if (system === undefined) throw new Error(`第 ${requestIndex} 次请求没有 system 消息`);
  return system.content;
}

// ---------------------------------------------------------------------------
// ① 触发写入（query 终结挂点）
// ---------------------------------------------------------------------------

describe('触发写入端到端', () => {
  it('显式记忆请求 → 完成后入库 + memory_written 事件（含来源会话）', async () => {
    const f = makeFixture([{ text: '好的，已记住。' }]);
    f.manager.createSession('s1');

    const { result } = await collect(f.manager.runQuery('s1', '请记住：我偏好简洁的回答', sig()));
    expect(result.stopReason).toBe('completed');

    const records = f.memoryStore.list();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: 'preference',
      content: '我偏好简洁的回答',
      sourceSessionId: 's1',
    });
    const written = f.events.filter((e) => e.type === 'memory_written');
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ recordId: records[0]?.id, kind: 'preference' });
  });

  it('普通输入不写入（白名单之外没有任何记录产生）', async () => {
    const f = makeFixture([{ text: '回答' }]);
    f.manager.createSession('s1');
    await collect(f.manager.runQuery('s1', '帮我算一下 2+2', sig()));
    expect(f.memoryStore.count()).toBe(0);
    expect(f.events.filter((e) => e.type === 'memory_written')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ② 检索注入（跨会话）
// ---------------------------------------------------------------------------

describe('检索注入端到端', () => {
  it('跨会话命中 → <user_profile> 注入 system（provider 收到的请求为证）', async () => {
    const f = makeFixture([
      { text: '好的，已记住。' }, // query 1：写入记忆
      { text: '按你的偏好：简洁。' }, // query 2：命中注入
    ]);
    f.manager.createSession('s1');
    await collect(f.manager.runQuery('s1', '请记住：我偏好简洁的回答', sig()));

    // 全新会话：记忆是跨会话的——这正是它存在的意义
    f.manager.createSession('s2');
    await collect(f.manager.runQuery('s2', '我偏好什么回答风格？', sig()));

    // 注入证据：第二个 query 的 system 含 profile 段与记忆行
    const system = systemOf(f, 1);
    expect(system).toContain('<user_profile>');
    expect(system).toContain('- 我偏好简洁的回答');

    // 事件证据
    const retrieved = f.events.filter((e) => e.type === 'memory_retrieved');
    expect(retrieved).toHaveLength(1);
    expect(retrieved[0]).toMatchObject({ count: 1 });
  });

  it('事实类记忆注入 task 层（<task_context>）', async () => {
    const f = makeFixture([{ text: '项目名是 harness-lab。' }]);
    f.memoryStore.write({ kind: 'fact', content: '项目名是 harness-lab' });
    f.manager.createSession('s1');

    await collect(f.manager.runQuery('s1', '项目名是什么？', sig()));

    const system = systemOf(f, 0);
    expect(system).toContain('<task_context>');
    expect(system).toContain('- 项目名是 harness-lab');
    expect(system).not.toContain('<user_profile>');
  });

  it('无相关记忆 → 无注入也无事件（对话照常）', async () => {
    const f = makeFixture([{ text: '回答' }]);
    f.memoryStore.write({ kind: 'preference', content: '我偏好简洁的回答' });
    f.manager.createSession('s1');

    await collect(f.manager.runQuery('s1', '今天天气如何？', sig()));

    const system = systemOf(f, 0);
    expect(system).not.toContain('<user_profile>');
    expect(system).not.toContain('<task_context>');
    expect(f.events.filter((e) => e.type === 'memory_retrieved')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ③ 短路语义（enabled=false）
// ---------------------------------------------------------------------------

describe('enabled=false 短路', () => {
  it('检索与写入都短路：不读库不写库不发事件（手工预置的记忆也不注入）', async () => {
    const f = makeFixture([{ text: '回答' }], { memoryEnabled: false });
    f.memoryStore.write({ kind: 'preference', content: '我偏好简洁的回答' }); // 手工预置
    f.manager.createSession('s1');

    // 输入同时含「显式请求」与「可检索关键词」——两个挂点都应被短路
    await collect(f.manager.runQuery('s1', '请记住：我偏好什么回答风格？', sig()));

    expect(f.events.filter((e) => e.type === 'memory_retrieved' || e.type === 'memory_written')).toHaveLength(0);
    expect(f.memoryStore.count()).toBe(1); // 没有新写入
    const system = systemOf(f, 0);
    expect(system).not.toContain('<user_profile>');
  });
});

// ---------------------------------------------------------------------------
// ④ 失败隔离（记忆是增强不是核心路径）
// ---------------------------------------------------------------------------

describe('失败隔离', () => {
  it('记忆库不可用 → 对话照常完成 + warn 日志（检索与写入双降级）', async () => {
    const f = makeFixture([{ text: '回答' }]);
    f.memoryStore.close(); // 模拟记忆库损坏：之后 list/write 都会抛错
    f.manager.createSession('s1');

    // 输入同时触发「检索」与「写入」两个挂点——两者都要各自降级
    const { result } = await collect(f.manager.runQuery('s1', '请记住：明天要开会', sig()));

    expect(result.stopReason).toBe('completed'); // 对话不受影响
    const warns = f.events.filter(
      (e): e is Extract<HarnessEvent, { type: 'log' }> => e.type === 'log' && e.level === 'warn',
    );
    expect(warns.some((e) => e.message.includes('记忆检索失败'))).toBe(true);
    expect(warns.some((e) => e.message.includes('记忆写入失败'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ⑤ 路径边界（aborted / failed）
// ---------------------------------------------------------------------------

describe('终结路径边界', () => {
  it('aborted 也做触发检查：显式请求的信号在输入里，与结局无关', async () => {
    const f = makeFixture([{ text: '不会被消费' }]);
    f.manager.createSession('s1');

    const controller = new AbortController();
    controller.abort(); // 预检取消：一轮都不跑
    const { result } = await collect(
      f.manager.runQuery('s1', '请记住：明天要开会', controller.signal),
    );

    expect(result.stopReason).toBe('aborted');
    expect(f.memoryStore.count()).toBe(1);
    expect(f.memoryStore.list()[0]).toMatchObject({ kind: 'fact', content: '明天要开会' });
  });

  it('failed（异常路径）不做触发检查：一半的对话没有可信度', async () => {
    const f = makeFixture([{ fail: { code: 'provider_error', message: '模拟断网' } }]);
    f.manager.createSession('s1');

    await expect(collect(f.manager.runQuery('s1', '请记住：明天要开会', sig()))).rejects.toThrow(
      '模拟断网',
    );
    expect(f.memoryStore.count()).toBe(0);
    expect(f.events.filter((e) => e.type === 'memory_written')).toHaveLength(0);
  });
});
