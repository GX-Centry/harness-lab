/**
 * LangGraph 对照层集成测试（w16）—— 对照实验的四个切片。
 *
 * 实验纪律：**唯一变量是控制流宿主**。同一个 FakeProvider 脚本、同一个
 * Dispatcher（四步执行链）、同一个 config——只有「谁来编排轮次」不同：
 *   A 宿主：我们手写的 AgentLoop（while + 手工状态）
 *   B 宿主：LangGraph StateGraph（引擎管理状态流转）
 *
 * §1 等价性：同脚本双宿主 → stopReason/turns/usage/finalMessage/工具轨迹逐字段相同
 * §2 max_turns 语义对齐：第 M 批工具「已执行」——与 while 循环的轮头检查等价
 * §3 持久化时机实测：我们的轮次边界快照 vs LangGraph 的每 super-step checkpoint
 * §4 取消：中断配对补位（我们的会话纯函数，在 LangGraph 宿主上原样复用）
 */

import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { MemorySaver } from '@langchain/langgraph';
import { createLoopGraph, runLangGraphQuery } from '../../src/adapters/langgraph/index.ts';
import type { HarnessConfig } from '../../src/config.ts';
import { defineConfig } from '../../src/config.ts';
import { HookPipeline } from '../../src/hooks/pipeline.ts';
import { AgentLoop } from '../../src/kernel/agent-loop.ts';
import type { LoopContext, LoopEvent, LoopResult } from '../../src/kernel/agent-loop.ts';
import { Dispatcher } from '../../src/kernel/dispatcher.ts';
import { EventBus } from '../../src/kernel/events.ts';
import { FakeProvider } from '../../src/llm/fake-provider.ts';
import type { FakeTurn } from '../../src/llm/fake-provider.ts';
import { PermissionGate } from '../../src/permission/gate.ts';
import { INTERRUPTED_TOOL_REASON } from '../../src/session/checkpoint.ts';
import { createBuiltinTools } from '../../src/tools/builtin/index.ts';
import { ToolRegistry } from '../../src/tools/registry.ts';
import type { AnyTool } from '../../src/types.ts';

// ===========================================================================
// §0 测试装置（两条宿主共用的装配）
// ===========================================================================

/** 共用装配：与 kernel 集成测试同构的最小链（空 hook 集合，对照无需 repeat-guard） */
function makeAssembly(config: HarnessConfig = defineConfig()) {
  const registry = new ToolRegistry();
  for (const tool of createBuiltinTools()) registry.register(tool);
  const bus = new EventBus();
  const hooks = new HookPipeline({ hooks: [], bus });
  const permission = new PermissionGate({ config: config.permission });
  const dispatcher = new Dispatcher({ registry, hooks, permission, bus, config });
  return { registry, bus, dispatcher, config };
}

function makeCtx(queryId: string, signal?: AbortSignal): LoopContext {
  return {
    sessionId: 's-lgc',
    queryId,
    workingDir: process.cwd(),
    signal: signal ?? new AbortController().signal,
  };
}

/** 消费 AgentLoop 的事件流并取回终态（走 completed 信封——设计者预期的简单消费方式） */
async function collectLoop(
  stream: AsyncGenerator<LoopEvent, LoopResult, void>,
): Promise<LoopResult> {
  let result: LoopResult | undefined;
  for await (const event of stream) {
    if (event.type === 'completed') result = event.result;
  }
  if (result === undefined) throw new Error('AgentLoop 未产出 completed 信封');
  return result;
}

/** 计算器场景（两条宿主共用的脚本与输入） */
const CALC_SCRIPT: readonly FakeTurn[] = [
  { text: '让我算一下。', toolCalls: [{ name: 'calculator', args: { expression: '21*2' } }] },
  { text: '结果是 42。' },
];
const CALC_INPUT = '21 * 2 等于多少？';

// ===========================================================================
// §1 等价性：同一脚本，两条宿主，同一结果
// ===========================================================================

describe('§1 等价性（双宿主，同脚本同结果）', () => {
  it('stopReason / turns / usage / finalMessage / 工具轨迹逐字段相同', async () => {
    const assembly = makeAssembly();

    // ---- A 宿主：我们的 AgentLoop ----
    const providerA = new FakeProvider({ script: CALC_SCRIPT });
    const loop = new AgentLoop({
      provider: providerA,
      dispatcher: assembly.dispatcher,
      registry: assembly.registry,
      bus: assembly.bus,
      config: assembly.config,
    });
    const resultA = await collectLoop(loop.run(CALC_INPUT, [], makeCtx('q_host_a')));

    // ---- B 宿主：LangGraph StateGraph ----
    const providerB = new FakeProvider({ script: CALC_SCRIPT });
    const resultB = await runLangGraphQuery(
      {
        provider: providerB,
        dispatcher: assembly.dispatcher,
        registry: assembly.registry,
        config: assembly.config,
      },
      CALC_INPUT,
      [],
      makeCtx('q_host_b'),
    );

    // ---- 逐字段对照 ----
    expect(resultA.stopReason).toBe('completed');
    expect(resultB.stopReason).toBe(resultA.stopReason);
    expect(resultA.turns).toBe(2);
    expect(resultB.turns).toBe(resultA.turns);
    expect(resultA.usage).toEqual(resultB.usage);
    expect(resultA.finalMessage?.content).toBe('结果是 42。');
    expect(resultB.finalMessage?.content).toBe(resultA.finalMessage?.content);

    // 两条宿主都消费了脚本的全部 2 个回合（不多不少）
    expect(providerA.consumedTurns).toBe(2);
    expect(providerB.consumedTurns).toBe(2);

    // 消息轨迹同构：user → assistant(tool) → tool(result) → assistant
    const roles = (r: LoopResult): string[] => r.messages.map((m) => m.role);
    expect(roles(resultA)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(roles(resultB)).toEqual(roles(resultA));

    // 工具结果入历史（calculator 对 21*2 的求值被两条宿主一致地传递）
    expect(resultA.messages[2]?.content).toContain('42');
    expect(resultB.messages[2]?.content).toBe(resultA.messages[2]?.content);
  });
});

// ===========================================================================
// §2 max_turns 语义对齐（易错边界：第 M 批工具「已执行」）
// ===========================================================================

describe('§2 max_turns 边界对齐', () => {
  it('脚本持续 tool_use：两条宿主都在「执行完第 M 批工具」后停止，且不多消费回合', async () => {
    const config = defineConfig({ loop: { maxTurns: 2 } });
    const assembly = makeAssembly(config);

    // 脚本只给 2 个回合：若宿主多消费第 3 回合，FakeProvider 会以
    // provider_error（脚本耗尽）自动暴露——「不多不少」由此被证明。
    const script: readonly FakeTurn[] = [
      { toolCalls: [{ name: 'calculator', args: { expression: '1+1' } }] },
      { toolCalls: [{ name: 'calculator', args: { expression: '2+2' } }] },
    ];

    const providerA = new FakeProvider({ script });
    const loop = new AgentLoop({
      provider: providerA,
      dispatcher: assembly.dispatcher,
      registry: assembly.registry,
      bus: assembly.bus,
      config: assembly.config,
    });
    const resultA = await collectLoop(loop.run('连续计算', [], makeCtx('q_max_a')));

    const providerB = new FakeProvider({ script });
    const resultB = await runLangGraphQuery(
      {
        provider: providerB,
        dispatcher: assembly.dispatcher,
        registry: assembly.registry,
        config: assembly.config,
      },
      '连续计算',
      [],
      makeCtx('q_max_b'),
    );

    for (const [label, result, provider] of [
      ['AgentLoop', resultA, providerA],
      ['LangGraph', resultB, providerB],
    ] as const) {
      expect(result.stopReason, label).toBe('max_turns');
      expect(result.turns, label).toBe(2);
      expect(provider.consumedTurns, label).toBe(2);
      // 第 2 批工具的结果**已写回历史**（user + a1 + t1 + a2 + t2 = 5 条）
      expect(result.messages.length, label).toBe(5);
      expect(result.messages[4]?.role, label).toBe('tool');
    }
  });
});

// ===========================================================================
// §3 持久化时机实测（「checkpoint」一词在两条体系里的语义之差的实证）
// ===========================================================================

describe('§3 持久化粒度对照', () => {
  it('同一次 2 轮 query：我们的轮次边界快照 1 次；LangGraph 每 super-step 一条 checkpoint', async () => {
    const assembly = makeAssembly();

    // ---- A 宿主：onTurnEnd 是我们唯一的「落盘时刻」接缝 ----
    const providerA = new FakeProvider({ script: CALC_SCRIPT });
    const loop = new AgentLoop({
      provider: providerA,
      dispatcher: assembly.dispatcher,
      registry: assembly.registry,
      bus: assembly.bus,
      config: assembly.config,
    });
    let snapshotCount = 0;
    await collectLoop(
      loop.run(CALC_INPUT, [], makeCtx('q_persist_a'), {
        onTurnEnd: () => {
          snapshotCount += 1;
        },
      }),
    );
    // 2 轮 query（tool_use → end_turn）：只有第 1 轮末尾回调；终结轮由
    // LoopResult 统一交付（agent-loop 决策 ⑥）——「轮次边界」语义的直接证据。
    expect(snapshotCount).toBe(1);

    // ---- B 宿主：checkpointer 在每个 super-step 后自动落一条 ----
    const providerB = new FakeProvider({ script: CALC_SCRIPT });
    const graph = createLoopGraph({
      provider: providerB,
      dispatcher: assembly.dispatcher,
      registry: assembly.registry,
      config: assembly.config,
      ctx: makeCtx('q_persist_b'),
      checkpointer: new MemorySaver(),
    });
    const runConfig = { configurable: { thread_id: 'q_persist_b' } };
    await graph.invoke({ messages: [], turns: 0, usage: { inputTokens: 0, outputTokens: 0 } }, runConfig);

    const history: unknown[] = [];
    for await (const snapshot of graph.getStateHistory(runConfig)) history.push(snapshot);
    // 实测 5 条（新→旧）：终态 / model#2 后 / tools#1 后 / model#1 后 / 输入。
    // 与我们的 1 次轮次边界快照对照：**粒度不同、目的不同**（对照笔记展开）。
    expect(history.length).toBeGreaterThanOrEqual(4);
  });
});

// ===========================================================================
// §4 取消：中断配对补位（两条宿主、两种时点、同一协议约束）
// ===========================================================================

/** 慢工具工厂：进入后阻塞，直到信号取消时抛 AbortError（附带「已进入」信号量） */
function makeSlowTool(): { tool: AnyTool; entered: Promise<void> } {
  let signalEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  const tool: AnyTool = {
    name: 'slow',
    description: '慢工具（等取消后抛 AbortError）',
    inputSchema: z.object({}),
    risk: 'low',
    execute: async (_input, toolCtx) => {
      signalEntered();
      await new Promise<void>((resolve) => {
        const check = (): void => {
          if (toolCtx.signal.aborted) resolve();
          else setTimeout(check, 2);
        };
        check();
      });
      throw new DOMException('慢工具被取消', 'AbortError');
    },
  };
  return { tool, entered };
}

describe('§4 取消与配对补位', () => {
  it('工具执行中取消：两条宿主都收敛为 aborted，且 tool_calls ↔ tool_result 配对完整', async () => {
    const config = defineConfig();
    const script: readonly FakeTurn[] = [
      { toolCalls: [{ name: 'slow', args: {} }] },
      { text: '不会到达' },
    ];

    // ---- A 宿主：AgentLoop 在**取消当下**补位（决策 ⑤）----
    const slowA = makeSlowTool();
    const assemblyA = makeAssembly(config);
    assemblyA.registry.register(slowA.tool);
    const providerA = new FakeProvider({ script });
    const loop = new AgentLoop({
      provider: providerA,
      dispatcher: assemblyA.dispatcher,
      registry: assemblyA.registry,
      bus: assemblyA.bus,
      config: assemblyA.config,
    });
    const controllerA = new AbortController();
    const runningA = collectLoop(loop.run('执行慢工具', [], makeCtx('q_cancel_a', controllerA.signal)));
    await slowA.entered;
    controllerA.abort();
    const resultA = await runningA;

    // ---- B 宿主：runner 在**恢复时**从 checkpoint 读回并补位 ----
    const slowB = makeSlowTool();
    const assemblyB = makeAssembly(config);
    assemblyB.registry.register(slowB.tool);
    const providerB = new FakeProvider({ script });
    const controllerB = new AbortController();
    const runningB = runLangGraphQuery(
      {
        provider: providerB,
        dispatcher: assemblyB.dispatcher,
        registry: assemblyB.registry,
        config: assemblyB.config,
      },
      '执行慢工具',
      [],
      makeCtx('q_cancel_b', controllerB.signal),
    );
    await slowB.entered;
    controllerB.abort();
    const resultB = await runningB;

    // ---- 协议约束（两条宿主必须都满足）----
    for (const [label, result] of [
      ['AgentLoop', resultA],
      ['LangGraph', resultB],
    ] as const) {
      expect(result.stopReason, label).toBe('aborted');
      expect(result.turns, label).toBe(1);

      // 配对完整：assistant 宣布了 1 个 tool_call → 历史里必须有 1 条 tool 结果
      const roles = result.messages.map((m) => m.role);
      expect(roles, label).toEqual(['user', 'assistant', 'tool']);
      const assistant = result.messages[1];
      const toolCount = assistant?.role === 'assistant' ? (assistant.toolCalls?.length ?? 0) : 0;
      expect(toolCount, label).toBe(1);
      // 半截轮次不入历史：第 2 回合的文本「不会到达」不在任何消息里
      expect(result.finalMessage?.content ?? '', label).not.toContain('不会到达');
    }

    // 补位文案的差异（各自的来源，注释留证）：
    //   A：AgentLoop 即时补位（「调用因会话取消而中止」）
    //   B：fillInterruptedToolResults（INTERRUPTED_TOOL_REASON，session 模块的恢复文案）
    expect(resultA.messages[2]?.content).toContain('取消');
    expect(resultB.messages[2]?.content).toBe(INTERRUPTED_TOOL_REASON);
  });
});
