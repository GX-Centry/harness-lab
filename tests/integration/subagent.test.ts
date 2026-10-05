/**
 * 子代理层集成测试 —— 全真链路下的 Agent-as-Tool 行为矩阵。
 *
 * 装配完整性（与本项目其它集成测试同款「全真链路」）：
 *   ToolRegistry → Dispatcher → FakeProvider → ContextManager → AgentLoop
 *   之上再叠加子代理世界：
 *   [父 Loop] → [父 Dispatcher] → [AgentTool.execute] → [子 Registry/Dispatcher/Loop]
 *
 * 覆盖矩阵（对齐 subagent/types.ts 的两个必答问题）：
 *   ① 端到端：父模型调子代理 → 子代理内调工具 → 摘要回父（隔离四层全验）；
 *   ② 工具子集：声明层看不见 + 执行层拒绝（结构性安全边界）；
 *   ③ 装配期错误：引用未注册工具 → config_error（第一现场暴露）；
 *   ④ 内部超时：协作式取消真正中止子循环 → timeout 失败回父；
 *   ⑤ 外部取消：父会话中止 → 级联取消 → AbortError 穿透 → 父 aborted；
 *   ⑥ 成本归属：子 usage 进 subagent 事件，父记账不含子（单轨分账）；
 *   ⑦ 轮次耗尽：子 max_turns → service_error（含拆解建议）；
 *   ⑧ fan-out：runSubagents 报告同序 / partial 语义 / 未知 agent 结构化失败；
 *   ⑨ 模型驱动：createOrchestratorTool（spawn_subagents 工具）端到端。
 */

import { describe, expect, it } from 'vitest';
import { defineConfig } from '../../src/config.ts';
import type { DeepPartial, HarnessConfig } from '../../src/config.ts';
import { ContextManager } from '../../src/context/manager.ts';
import { HarnessError } from '../../src/errors.ts';
import { HookPipeline } from '../../src/hooks/pipeline.ts';
import { AgentLoop } from '../../src/kernel/agent-loop.ts';
import type { LoopContext, LoopResult } from '../../src/kernel/agent-loop.ts';
import { Dispatcher } from '../../src/kernel/dispatcher.ts';
import type { HarnessEvent } from '../../src/kernel/events.ts';
import { EventBus } from '../../src/kernel/events.ts';
import { FakeProvider } from '../../src/llm/fake-provider.ts';
import type { FakeTurn } from '../../src/llm/fake-provider.ts';
import { PermissionGate } from '../../src/permission/gate.ts';
import { registerAgentTools } from '../../src/subagent/agent-tool.ts';
import { createOrchestratorTool, runSubagents } from '../../src/subagent/orchestrator.ts';
import type { SubAgentDefinition, SubAgentDeps } from '../../src/subagent/types.ts';
import { createBuiltinTools } from '../../src/tools/builtin/index.ts';
import { ToolRegistry } from '../../src/tools/registry.ts';

// ---------------------------------------------------------------------------
// 测试装置
// ---------------------------------------------------------------------------

const PARENT_SYSTEM = '父测试 system';
const RESEARCHER_SYSTEM = '你是资料研究员。';

/** 默认子代理定义：研究员（可访问 echo + calculator 两个工具） */
const DEFAULT_RESEARCHER: SubAgentDefinition = {
  name: 'researcher',
  description: '资料调研子代理',
  systemPrompt: RESEARCHER_SYSTEM,
  toolNames: ['echo', 'calculator'],
  maxTurns: 3,
};

interface SubFixture {
  readonly events: HarnessEvent[];
  readonly parentProvider: FakeProvider;
  /** providerFactory 创建的全部子 Provider（按创建顺序——每次子任务一个新实例） */
  readonly subProviders: FakeProvider[];
  readonly tools: ToolRegistry;
  readonly deps: SubAgentDeps;
  readonly definitions: readonly SubAgentDefinition[];
  /** 跑一轮父 query（事件已由 bus 收集），返回终态 */
  run(input: string, signal?: AbortSignal): Promise<LoopResult>;
}

interface FixtureOptions {
  readonly parentScript: readonly FakeTurn[];
  /** 子代理剧本（每个子任务新建的 provider 都消费这一份——单回合场景够用） */
  readonly subagentScript?: readonly FakeTurn[];
  readonly definitions?: readonly SubAgentDefinition[];
  /** 子 provider 开启分片延迟（10ms/片）——超时与取消用例的时间基础 */
  readonly slowChunks?: boolean;
  readonly overrides?: DeepPartial<HarnessConfig>;
  /** 把 spawn_subagents 工具注册进父 registry（模型驱动 fan-out 用例） */
  readonly withSpawnTool?: boolean;
}

function makeFixture(options: FixtureOptions): SubFixture {
  const config = defineConfig(options.overrides ?? {});
  let tick = 1_700_000_000_000;
  const clock = (): number => (tick += 1);

  const tools = new ToolRegistry();
  for (const tool of createBuiltinTools()) tools.register(tool);

  const bus = new EventBus({ now: clock });
  const events: HarnessEvent[] = [];
  bus.on('*', (event) => events.push(event));

  const hooks = new HookPipeline({ hooks: [], bus });
  // confirm 处理器模拟「交互式 CLI 中用户确认放行」——子代理工具是
  // medium（confirm 策略），没有确认通道会被 fail-safe 拒绝（见 gate.ts）。
  const permission = new PermissionGate({
    config: config.permission,
    confirm: () => Promise.resolve(true),
  });
  const dispatcher = new Dispatcher({ registry: tools, hooks, permission, bus, config, now: clock });

  // 关键：工厂每次返回**新实例**——FakeProvider 的脚本游标是可变状态，
  // 共享实例会被并发子代理交错消费（这正是 providerFactory 存在的原因）。
  const subProviders: FakeProvider[] = [];
  const providerFactory = (agent: SubAgentDefinition): FakeProvider => {
    void agent;
    const provider = new FakeProvider({
      script: options.subagentScript ?? [],
      chunkSize: 8,
      chunkDelayMs: options.slowChunks === true ? 10 : 0,
    });
    subProviders.push(provider);
    return provider;
  };

  const deps: SubAgentDeps = { tools, hooks, permission, bus, config, providerFactory, now: clock };
  const definitions = options.definitions ?? [DEFAULT_RESEARCHER];
  registerAgentTools(tools, definitions, deps);
  if (options.withSpawnTool === true) {
    tools.register(createOrchestratorTool({ definitions, deps }));
  }

  const parentProvider = new FakeProvider({ script: options.parentScript });
  const contextManager = new ContextManager({
    config: config.context,
    count: (text) => parentProvider.countTokens(text),
    bus,
  });
  const loop = new AgentLoop({
    provider: parentProvider,
    dispatcher,
    registry: tools,
    bus,
    config,
    contextManager,
    systemPrompt: PARENT_SYSTEM,
    now: clock,
  });

  const run = async (input: string, signal?: AbortSignal): Promise<LoopResult> => {
    const ctx: LoopContext = {
      sessionId: 'sub-test',
      queryId: 'q_sub_test',
      workingDir: process.cwd(),
      signal: signal ?? new AbortController().signal,
    };
    let result: LoopResult | undefined;
    for await (const event of loop.run(input, [], ctx)) {
      if (event.type === 'completed') result = event.result;
    }
    if (result === undefined) throw new Error('Loop 未产出终态信封');
    return result;
  };

  return { events, parentProvider, subProviders, tools, deps, definitions, run };
}

/** 与 FakeProvider.deriveUsage 同构的输入 token 重算（用于「父记账不含子」的硬断言） */
function derivedInputTokens(provider: FakeProvider, index: number): number {
  const req = provider.requests[index];
  if (req === undefined) return 0;
  const parts: string[] = [];
  for (const m of req.messages) parts.push(m.content);
  for (const spec of req.tools ?? []) {
    parts.push(`${spec.name} ${spec.description} ${JSON.stringify(spec.inputSchema)}`);
  }
  return provider.countTokens(parts.join('\n'));
}

// ---------------------------------------------------------------------------
// ① 端到端（隔离四层全验）
// ---------------------------------------------------------------------------

describe('AgentTool：端到端', () => {
  it('父模型调用子代理 → 子代理内部执行工具 → 摘要回父（隔离四层）', async () => {
    const f = makeFixture({
      parentScript: [
        { text: '我来安排调研。', toolCalls: [{ name: 'researcher', args: { task: '查一下 21*2' } }] },
        { text: '调研完成：42。' },
      ],
      subagentScript: [
        { text: '我来计算。', toolCalls: [{ name: 'calculator', args: { expression: '21*2' } }] },
        { text: '结论：21*2=42。' },
      ],
    });

    const result = await f.run('帮我调研一下');

    // ---- 父侧：子世界的全部过程只呈现为一条工具结果（隔离层 4）----
    expect(result.stopReason).toBe('completed');
    expect(result.finalMessage?.content).toBe('调研完成：42。');
    const parentToolMsg = result.messages.find((m) => m.role === 'tool' && m.name === 'researcher');
    expect(parentToolMsg?.content).toBe('结论：21*2=42。');

    // ---- 子侧：独立 system（层 2）+ 空历史 + 任务自包含（层 1）----
    const subRequests = f.subProviders[0]?.requests ?? [];
    expect(subRequests).toHaveLength(2); // 子代理自己跑了 2 轮
    const firstMessages = subRequests[0]?.messages ?? [];
    expect(firstMessages[0]?.role).toBe('system');
    expect(firstMessages[0]?.content).toContain(RESEARCHER_SYSTEM);
    // 父的 system 一个字都不进子世界
    expect(firstMessages.some((m) => m.content.includes(PARENT_SYSTEM))).toBe(false);
    // 子世界的历史只有任务本身
    expect(firstMessages.some((m) => m.role === 'user' && m.content === '查一下 21*2')).toBe(true);

    // ---- 事件证据：成对 + 子世界事件带派生 queryId（可归因）----
    const started = f.events.filter((e) => e.type === 'subagent_started');
    expect(started).toHaveLength(1);
    expect(started[0]?.type === 'subagent_started' && started[0].taskLength).toBe('查一下 21*2'.length);
    const finished = f.events.find((e) => e.type === 'subagent_finished');
    expect(finished?.type === 'subagent_finished' && finished.ok).toBe(true);

    const calcFinished = f.events.find((e) => e.type === 'tool_finished' && e.name === 'calculator');
    expect(calcFinished?.queryId).toContain('>researcher'); // 子世界的工具执行可归因
  });
});

// ---------------------------------------------------------------------------
// ② 工具子集（结构性安全边界）
// ---------------------------------------------------------------------------

describe('AgentTool：工具子集', () => {
  it('声明层看不见未授权工具；执行层按未知工具拒绝（不靠提示过滤）', async () => {
    const f = makeFixture({
      definitions: [{ ...DEFAULT_RESEARCHER, toolNames: ['echo'] }], // 只给 echo
      parentScript: [
        { text: '派研究员。', toolCalls: [{ name: 'researcher', args: { task: '计算 1+1' } }] },
        { text: '知道了。' },
      ],
      subagentScript: [
        { text: '我试试计算。', toolCalls: [{ name: 'calculator', args: { expression: '1+1' } }] },
        { text: '计算工具不可用，无法完成。' },
      ],
    });

    const result = await f.run('测试');

    // 声明层：子模型看到的工具列表里只有 echo
    const subRequests = f.subProviders[0]?.requests ?? [];
    expect(subRequests[0]?.tools?.map((t) => t.name)).toEqual(['echo']);

    // 执行层：即使模型幻觉出 calculator，子 Dispatcher 也按未知工具拒绝
    const toolMsg = subRequests[1]?.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('不存在名为');
    expect(toolMsg?.content).toContain('echo'); // 失败提示里列出子世界真实可用的工具

    // 硬证据：calculator 从未执行（快速路径直接拒绝——没有 tool_started）
    const calcStarted = f.events.filter((e) => e.type === 'tool_started' && e.name === 'calculator');
    expect(calcStarted).toHaveLength(0);

    // 子代理把失败收敛进自己的回答，摘要照常回父
    const parentToolMsg = result.messages.find((m) => m.role === 'tool' && m.name === 'researcher');
    expect(parentToolMsg?.content).toBe('计算工具不可用，无法完成。');
  });
});

// ---------------------------------------------------------------------------
// ③ 装配期错误
// ---------------------------------------------------------------------------

describe('AgentTool：装配期错误', () => {
  it('定义引用未注册工具 → 立即 config_error（不静默跳过）', () => {
    const config = defineConfig();
    const tools = new ToolRegistry();
    for (const tool of createBuiltinTools()) tools.register(tool);
    const bus = new EventBus();
    const hooks = new HookPipeline({ hooks: [], bus });
    const permission = new PermissionGate({ config: config.permission });
    const deps: SubAgentDeps = {
      tools,
      hooks,
      permission,
      bus,
      config,
      providerFactory: () => new FakeProvider({ script: [] }),
    };

    const bad: SubAgentDefinition = {
      name: 'bad',
      description: '引用不存在的工具',
      systemPrompt: 'x',
      toolNames: ['no-such-tool'],
    };

    expect(() => registerAgentTools(tools, [bad], deps)).toThrow(HarnessError);
    expect(() => registerAgentTools(tools, [bad], deps)).toThrow(/no-such-tool/);
  });
});

// ---------------------------------------------------------------------------
// ④ 内部超时（协作式取消）
// ---------------------------------------------------------------------------

describe('AgentTool：内部超时', () => {
  it('taskTimeoutMs 到时真正中止子循环 → timeout 失败结果回父（父不中断）', async () => {
    const f = makeFixture({
      overrides: { subagent: { taskTimeoutMs: 50 } }, // 50ms 超时（慢流 500ms）
      slowChunks: true,
      parentScript: [
        { text: '派研究员慢慢做。', toolCalls: [{ name: 'researcher', args: { task: '写一篇长文' } }] },
        { text: '超时了，我换个方式。' },
      ],
      subagentScript: [{ text: 'A'.repeat(400) }], // 50 片 × 10ms —— 远超市
    });

    const result = await f.run('开始');

    // 超时是「数据」不是「父的取消」：父照常完成自己的循环
    expect(result.stopReason).toBe('completed');
    const parentToolMsg = result.messages.find((m) => m.role === 'tool' && m.name === 'researcher');
    expect(parentToolMsg?.content).toContain('超时');

    const finished = f.events.find((e) => e.type === 'subagent_finished');
    expect(finished?.type === 'subagent_finished' && finished.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ⑤ 外部取消（AbortError 穿透）
// ---------------------------------------------------------------------------

describe('AgentTool：外部取消', () => {
  it('父会话中止 → 级联取消子循环 → AbortError 穿透 → 父收敛为 aborted', async () => {
    const f = makeFixture({
      slowChunks: true,
      parentScript: [
        { text: '派研究员。', toolCalls: [{ name: 'researcher', args: { task: '慢慢来' } }] },
      ],
      subagentScript: [{ text: 'B'.repeat(400) }], // 500ms 慢流
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30); // 子流进行中触发外部取消

    const result = await f.run('开始', controller.signal);
    clearTimeout(timer);

    expect(result.stopReason).toBe('aborted');
    // 父 Loop 的取消补位：assistant(tool_calls) ↔ tool 配对不因取消而残缺
    const parentToolMsg = result.messages.find((m) => m.role === 'tool' && m.name === 'researcher');
    expect(parentToolMsg?.content).toContain('取消');

    const finished = f.events.find((e) => e.type === 'subagent_finished');
    expect(finished?.type === 'subagent_finished' && finished.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ⑥ 成本归属（单轨分账）
// ---------------------------------------------------------------------------

describe('AgentTool：成本归属', () => {
  it('子代理 usage 进 subagent_finished 事件；父记账只含父自己（不含子）', async () => {
    const f = makeFixture({
      parentScript: [
        { text: '派单。', toolCalls: [{ name: 'researcher', args: { task: '查' } }] },
        { text: '完成。' },
      ],
      subagentScript: [{ text: '调研结论：好。' }],
    });

    const result = await f.run('开始');

    // 子代理独立用量（事件证据——可观测层靠它做跨层级汇总）
    const finished = f.events.find((e) => e.type === 'subagent_finished');
    expect(finished?.type === 'subagent_finished').toBe(true);
    const subUsage = finished?.type === 'subagent_finished' ? finished.usage : undefined;
    expect(subUsage?.inputTokens ?? 0).toBeGreaterThan(0);

    // 硬断言：父 usage == 父自己两次请求的输入之和（单轨分账——子不合并进父）
    const parentDerived =
      derivedInputTokens(f.parentProvider, 0) + derivedInputTokens(f.parentProvider, 1);
    expect(result.usage.inputTokens).toBe(parentDerived);
    expect(f.parentProvider.requests).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// ⑦ 轮次耗尽（max_turns 映射）
// ---------------------------------------------------------------------------

describe('AgentTool：轮次耗尽', () => {
  it('子 maxTurns 用尽 → service_error（含「拆解任务」修正建议）', async () => {
    const f = makeFixture({
      definitions: [{ ...DEFAULT_RESEARCHER, maxTurns: 1 }],
      parentScript: [
        { text: '派单。', toolCalls: [{ name: 'researcher', args: { task: '复杂任务' } }] },
        { text: '范围太大，我拆小重试。' },
      ],
      subagentScript: [{ text: '先看看。', toolCalls: [{ name: 'echo', args: { message: 'x' } }] }],
    });

    const result = await f.run('开始');

    const parentToolMsg = result.messages.find((m) => m.role === 'tool' && m.name === 'researcher');
    expect(parentToolMsg?.content).toContain('轮次上限');
    expect(parentToolMsg?.content).toContain('拆解');
    expect(result.stopReason).toBe('completed'); // 子失败不阻断父
  });
});

// ---------------------------------------------------------------------------
// ⑧ fan-out（runSubagents）
// ---------------------------------------------------------------------------

describe('runSubagents：fan-out 报告', () => {
  it('并发分派：报告与输入同序；未知 agent 结构化失败（partial 语义）', async () => {
    const f = makeFixture({
      parentScript: [], // 本用例不跑父 Loop——直接驱动编排 API
      subagentScript: [{ text: '子任务完成。' }],
    });

    const report = await runSubagents({
      deps: f.deps,
      definitions: f.definitions,
      tasks: [
        { agent: 'researcher', task: '任务 A' },
        { agent: 'researcher', task: '任务 B' },
        { agent: 'ghost', task: '任务 C' },
      ],
      context: { sessionId: 'fan-out', queryId: 'q_fanout', workingDir: process.cwd() },
    });

    expect(report.outcomes).toHaveLength(3);
    expect(report.okCount).toBe(2);
    expect(report.failCount).toBe(1);

    // 同序归位（完成顺序不影响报告顺序）
    expect(report.outcomes.map((o) => o.task)).toEqual(['任务 A', '任务 B', '任务 C']);

    const first = report.outcomes[0];
    expect(first?.ok).toBe(true);
    if (first?.ok === true) {
      expect(first.summary).toBe('子任务完成。');
      expect(first.usage.inputTokens).toBeGreaterThan(0); // 独立记账
    }

    const ghost = report.outcomes[2];
    expect(ghost?.ok).toBe(false);
    if (ghost?.ok === false) {
      expect(ghost.reason).toBe('unknown_agent');
      expect(ghost.errorCode).toBe('input_error');
      expect(ghost.message).toContain('researcher'); // 错误信息列出可用代理
    }

    expect(report.totalUsage.inputTokens).toBeGreaterThan(0);
    // 两个成功任务 = 两个独立 provider 实例（工厂每次新建）
    expect(f.subProviders).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// ⑨ 模型驱动 fan-out（spawn_subagents 工具）
// ---------------------------------------------------------------------------

describe('createOrchestratorTool：模型驱动 fan-out', () => {
  it('父模型调用 spawn_subagents → 报告文本回传模型', async () => {
    const f = makeFixture({
      withSpawnTool: true,
      parentScript: [
        {
          text: '我来分派任务。',
          toolCalls: [
            { name: 'spawn_subagents', args: { tasks: [{ agent: 'researcher', task: '算 6*7' }] } },
          ],
        },
        { text: '分派结果已汇总。' },
      ],
      subagentScript: [{ text: '6*7=42。' }],
    });

    const result = await f.run('帮我并行处理');

    expect(result.stopReason).toBe('completed');
    const toolMsg = result.messages.find((m) => m.role === 'tool' && m.name === 'spawn_subagents');
    expect(toolMsg?.content).toContain('并发分派完成');
    expect(toolMsg?.content).toContain('✓ researcher');
    expect(toolMsg?.content).toContain('6*7=42。');
  });
});

// ---------------------------------------------------------------------------
// ⑩ 配置防呆
// ---------------------------------------------------------------------------

describe('subagent 配置防呆', () => {
  it('非正的并发/超时/轮次在启动期抛 config_error', () => {
    expect(() => defineConfig({ subagent: { maxConcurrency: 0 } })).toThrow(HarnessError);
    expect(() => defineConfig({ subagent: { taskTimeoutMs: 0 } })).toThrow(/subagent/);
    expect(() => defineConfig({ subagent: { maxTurns: -1 } })).toThrow(/subagent/);
  });
});
