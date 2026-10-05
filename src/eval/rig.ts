/**
 * Core Rig —— Eval 的「最小内核装配」。
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 为什么 Eval 自带一份装配？                                            │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * 场景评测需要的是「剥光外壳的内核」：
 *   config → registry → bus → hooks → permission → dispatcher
 *   → provider → contextManager → loop（+ 可选 subagent / 可观测）
 *
 * w18 起共有三种评测装配形态（谱系从轻到重）：
 *   - Core Rig（本文件 §3）：纯内存内核——高频断言的默认形态；
 *   - Session Rig（session-rig.ts）：Core + Session/SQLite——「会话恢复」
 *     类场景（跨进程语义）的形态；
 *   - bootProcess（scripts/lab.ts）：含全部模块的整机形态——「可运行」证明，
 *     不适合高频断言（磁盘 IO + 进程状态）。
 *
 * 装配纪律与 bootProcess 完全一致（依赖顺序即接线顺序）：
 *   - providerFactory 每个子任务新建 Provider（w13 的并发正确性前提）；
 *   - PermissionGate 的 confirm 缺省为 undefined = fail-safe 拒绝——
 *     场景用 autoApprovePermissions 显式选择「交互式 CLI」行为；
 *   - 可观测（Tracer/CostTracker）按 config 开关装配，供断言与演示消费。
 *
 * 确定性约定（铁律 2）：
 *   - sessionId/queryId 是固定字符串（`eval:<name>` / `q_eval_<name>`），
 *     不用随机数——同一场景任意次运行产出逐字节相同的事件流；
 *   - 时钟可注入（options.now），缺省 Date.now 只影响 ts 字段。
 *
 * 演进点（w18 兑现与保留）：
 *   - 第二个 rig 形态已落地：session-rig.ts 的 Session Rig（含 Session/SQLite
 *     的完整装配）——「崩溃恢复」类断言的真实需求在 w18 场景层出现后兑现；
 *   - 多轮对话：Session Rig 的 run 可重复调用（每次一个新 query）自然支持；
 *   - 「完整装配 + Memory」仍是保留区：记忆注入断言需求尚未出现（P2）。
 *
 * 依赖方向：eval/rig.ts → 全部业务模块（eval 是横切消费层，依赖一切）。
 */

import { defineConfig } from '../config.ts';
import type { HarnessConfig } from '../config.ts';
import { ContextManager } from '../context/manager.ts';
import { createDefaultHooks } from '../hooks/builtin/index.ts';
import { HookPipeline } from '../hooks/pipeline.ts';
import { AgentLoop } from '../kernel/agent-loop.ts';
import type { LoopEvent, LoopResult } from '../kernel/agent-loop.ts';
import { Dispatcher } from '../kernel/dispatcher.ts';
import { EventBus } from '../kernel/events.ts';
import type { HarnessEvent } from '../kernel/events.ts';
import { FakeProvider } from '../llm/fake-provider.ts';
import { CostTracker } from '../observability/cost.ts';
import { Tracer } from '../observability/tracer.ts';
import { PermissionGate } from '../permission/gate.ts';
import { registerAgentTools } from '../subagent/agent-tool.ts';
import { createOrchestratorTool } from '../subagent/orchestrator.ts';
import type { SubAgentDeps } from '../subagent/types.ts';
import { createBuiltinTools } from '../tools/builtin/index.ts';
import { ToolRegistry } from '../tools/registry.ts';
import type { EvalScenario, ScenarioEvidence } from './types.ts';

// ===========================================================================
// §1 选项与句柄
// ===========================================================================

export interface CoreRigOptions {
  /** 时钟注入（ts / duration 的确定性；缺省 Date.now） */
  readonly now?: () => number;
  /** 工具沙箱根目录（缺省 process.cwd()） */
  readonly workingDir?: string;
  /** 主循环 system prompt 覆盖（缺省评测场景通用人格） */
  readonly systemPrompt?: string;
}

export interface RunOptions {
  /** 取消信号（评测取消路径时可传；缺省永不取消） */
  readonly signal?: AbortSignal;
}

/** 场景 Harness：装配好的一台「内核试验机」（run 可重复调用） */
export interface ScenarioHarness {
  readonly scenario: EvalScenario;
  readonly config: HarnessConfig;
  /** 主世界 Provider（requests 记录供上下文断言） */
  readonly provider: FakeProvider;
  readonly bus: EventBus;
  /** 全量事件追踪（config.observability.trace 关闭时为 undefined） */
  readonly tracer: Tracer | undefined;
  /** 计价账本（config.observability.costTracking 关闭时为 undefined） */
  readonly cost: CostTracker | undefined;
  readonly sessionId: string;
  readonly queryId: string;
  run(input: string, options?: RunOptions): Promise<ScenarioEvidence>;
  /** 释放订阅（评估收尾必调；幂等） */
  close(): void;
}

// ===========================================================================
// §2 共享装配（两个 rig 形态的唯一装配接缝）
// ===========================================================================

/**
 * 一次内核装配的全部产物。
 * Core Rig（§3）与 Session Rig（session-rig.ts）在此之上只做「run 语义」
 * 与「额外资源生命周期」的差异——装配本身共享一份实现，避免两个 rig
 * 各自漂移（对照阅读两个 rig 的 run 即可看清差异本身）。
 */
export interface AssembledHarness {
  readonly scenario: EvalScenario;
  readonly config: HarnessConfig;
  readonly registry: ToolRegistry;
  readonly bus: EventBus;
  /** rig 采集的全部事件（run 时按 mark 切片——见各 rig 的 run） */
  readonly events: HarnessEvent[];
  readonly provider: FakeProvider;
  readonly tracer: Tracer | undefined;
  readonly cost: CostTracker | undefined;
  readonly loop: AgentLoop;
  readonly sessionId: string;
  readonly queryId: string;
  /** 工具沙箱根目录（Session Rig 的 SessionManager 构造也要用） */
  readonly workingDir: string;
  /** 释放可观测订阅（幂等；会话等额外资源由各自 rig 的 close 负责） */
  dispose(): void;
}

/**
 * 装配一台「内核试验机」：
 *   config → registry → bus → hooks → permission → dispatcher
 *   → provider → contextManager → loop（+ 可选子代理/编排/可观测）。
 *
 * 这里是「场景协议 → 真实装配」的唯一翻译点（types.ts 的 hooks /
 * permissionRules / enableOrchestrator / autoApprovePermissions 在此生效）。
 * 装配范围刻意不含 Session/Memory/Commands/Skills——那种「完整形态」
 * 由 session-rig.ts（评测侧）与 src/cli/app.ts（产品侧）各自拼装。
 */
export function assembleHarness(
  scenario: EvalScenario,
  options: CoreRigOptions = {},
): AssembledHarness {
  const now = options.now ?? Date.now;
  const workingDir = options.workingDir ?? process.cwd();

  // ---- 1. 配置：场景 overrides 深合并（同 defineConfig 语义）----
  const config = defineConfig(scenario.overrides ?? {});

  // ---- 2. 工具注册（内置演示工具：calculator / echo / fs-read / fs-write）----
  const registry = new ToolRegistry();
  for (const tool of createBuiltinTools()) {
    registry.register(tool);
  }

  // ---- 3. 事件总线 + rig 自带采集 ----
  // 采集用独立订阅而非 Tracer：断言的证据完整性不依赖可观测开关
  // （Tracer 是「给人和生产用的」；rig 的 events 是「给断言用的」）。
  const bus = new EventBus({ now });
  const events: HarnessEvent[] = [];
  bus.on('*', (event) => {
    events.push(event);
  });

  // ---- 4. Hooks / Permission / Dispatcher（四步链）----
  // hooks：默认集 + 场景追加（同 priority 时稳定序：默认先、追加后）；
  // 场景追加是「改写类」能力的注入点（如 modify_input 的自定义 hook）。
  const hooks = new HookPipeline({
    hooks: [...createDefaultHooks(config.hooks), ...(scenario.hooks ?? [])],
    bus,
  });
  const permission = new PermissionGate({
    config: config.permission,
    rules: scenario.permissionRules, // undefined = 空表（全部走风险策略）
    // 缺省 undefined = 无确认通道 → fail-safe 拒绝（非交互环境的真实语义）
    confirm:
      scenario.autoApprovePermissions === true ? () => Promise.resolve(true) : undefined,
  });
  const dispatcher = new Dispatcher({ registry, hooks, permission, bus, config, now });

  // ---- 5. Provider / ContextManager / Loop（内核三件套）----
  const provider = new FakeProvider({ script: scenario.script });
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
    systemPrompt: options.systemPrompt ?? '你是 harness-lab 评测场景中的助手。',
    now,
  });

  // ---- 6. 可选：子代理装配（场景声明了才接线）----
  if (scenario.subagents !== undefined && scenario.subagents.length > 0) {
    const deps: SubAgentDeps = {
      tools: registry,
      hooks,
      permission,
      bus,
      config,
      now,
      // 每个子任务新建 Provider（独立剧本游标——并发正确性前提，见 w13）
      providerFactory: (agent) => new FakeProvider({ script: scenario.subagentScripts?.[agent.name] ?? [] }),
    };
    registerAgentTools(registry, scenario.subagents, deps);
    // 可选：spawn_subagents 编排工具（fan-out 场景——模型一次调用并发派发）
    if (scenario.enableOrchestrator === true) {
      registry.register(createOrchestratorTool({ definitions: scenario.subagents, deps }));
    }
  }

  // ---- 7. 可选：可观测（按 config 开关；关闭时保持 undefined 让断言可分辨）----
  const tracer = config.observability.trace ? new Tracer({ bus, config: config.observability }) : undefined;
  const cost = config.observability.costTracking
    ? new CostTracker({ bus, config: config.observability })
    : undefined;

  // ---- 8. 确定性标识：固定字符串（不用随机数——见文件头确定性约定）----
  const sessionId = `eval:${scenario.name}`;
  const queryId = `q_eval_${scenario.name}`;

  // ---- 9. dispose：释放可观测订阅（幂等——两个 rig 的 close 都可能触发）----
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    tracer?.dispose();
    cost?.dispose();
  };

  return {
    scenario,
    config,
    registry,
    bus,
    events,
    provider,
    tracer,
    cost,
    loop,
    sessionId,
    queryId,
    workingDir,
    dispose,
  };
}

// ===========================================================================
// §3 createCoreRig —— run = 直接驱动 Loop（无会话层）
// ===========================================================================

/**
 * Core Rig：不碰磁盘、不起会话、不装命令层——一次场景 = 纯内存确定性推演。
 *
 * run 语义（对照 session-rig.ts 的「跨进程恢复」）：
 *   - 每次 run 传空历史——没有会话层；多 run 只共享 Provider 的请求记录；
 *   - evidence.session 保持 undefined（会话面断言会给出「未使用 Session Rig」
 *     的自足失败原因——两个 rig 的证据形状差异可分辨）。
 */
export function createCoreRig(scenario: EvalScenario, options: CoreRigOptions = {}): ScenarioHarness {
  const core = assembleHarness(scenario, options);
  let closed = false;

  return {
    scenario: core.scenario,
    config: core.config,
    provider: core.provider,
    bus: core.bus,
    tracer: core.tracer,
    cost: core.cost,
    sessionId: core.sessionId,
    queryId: core.queryId,

    async run(input: string, runOptions: RunOptions = {}): Promise<ScenarioEvidence> {
      const mark = core.events.length; // 本次 run 的事件切片起点（支持同一 rig 多次 run）
      const signal = runOptions.signal ?? new AbortController().signal;
      const loopEvents: LoopEvent[] = [];
      let result: LoopResult | undefined;

      // 背压消费整个事件流：Loop 的自然驱动方式（与 CLI 的消费形态一致）。
      // 历史传空数组——Core Rig 无会话层（对照 bootProcess 的 loadMessages）。
      for await (const event of core.loop.run(input, [], {
        sessionId: core.sessionId,
        queryId: core.queryId,
        workingDir: core.workingDir,
        signal,
      })) {
        loopEvents.push(event);
        if (event.type === 'completed') {
          result = event.result;
        }
      }

      return {
        result,
        loopEvents,
        events: core.events.slice(mark),
        requests: [...core.provider.requests], // 快照：外部不可改内部记录（多次 run 时累积）
        cost: core.cost,
        sessionId: core.sessionId,
        queryId: core.queryId,
      };
    },

    close(): void {
      if (closed) return; // 幂等（runner 的 finally 可能重复调用）
      closed = true;
      core.dispose();
    },
  };
}
