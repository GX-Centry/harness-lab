/**
 * 子代理层（Sub-agent）—— 协议与形状（w13）。
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 定位：Agent-as-Tool —— 子代理对父代理而言就是「一个普通工具」         │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * 数据流（父视角）：
 *
 *   父 Loop 轮次 → 模型产出 tool_call{name:'researcher', args:{task:'...'}}
 *     → 父 Dispatcher 四步链（校验/权限/hook/兜底 全部照常）
 *     → AgentTool.execute({task})          ← 本模块的入口
 *     → 【子世界】childRegistry + childDispatcher + 独立 Provider
 *                  + 独立 ContextManager + 独立 AgentLoop
 *     → 子 Loop 跑完整 query（可能 N 轮、可能再调工具）
 *     → 只把 finalMessage 摘要作为 ToolResult 交回父世界
 *     → 父模型看到一条普通的工具结果，继续自己的循环
 *
 * 「把子代理做成工具」而不是「做成内核特例」的理由：
 *   一切横切能力（权限、审计、截断、超时、hook）已经在 Dispatcher 上
 *   就位——子代理作为工具自动继承全部；内核零改动。这正是「协议是扩展
 *   点」的兑现：新能力不需要新管道，只需要新实现。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 必答问题 ①：上下文隔离是怎么做的？（四层，缺一不可）
 *
 *   层 1  空历史：子 Loop 从 [] 开始，父对话历史一步都不进子世界。
 *        理由：子任务只需要「任务描述」；把父的完整对话灌进去会让
 *        窄任务被无关上下文稀释（而且父历史可能超出子任务的预算）。
 *   层 2  独立 systemPrompt：定义里显式声明子代理人格/职责边界。
 *        理由：子代理不是父代理的复制品——「你是一个只做资料检索的
 *        代理」与父的人设完全不同，共用 system 会产生角色混淆。
 *   层 3  工具子集（安全边界，不是提示过滤）：childRegistry 只注册
 *        definition.toolNames 里的工具——子模型**在协议层面看不见**
 *        其他工具（ToolSpec 列表里就没有），即使幻觉出工具名，子
 *        Dispatcher 也会按「未知工具」拒绝。隔离由结构保证，不靠
 *        system prompt 里的君子协定。
 *   层 4  结果只回摘要：子世界的全部中间过程（N 轮对话、工具流水）
 *        在父世界里只呈现为一条 ToolResult.content = 最终文本。
 *        理由：父的上下文预算不为子过程买单；子代理的价值是「结论」
 *        而不是「过程」（过程对审计可见——见 subagent_* 事件与
 *        子 queryId 派生，但那走诊断通道，不进模型上下文）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 必答问题 ②：成本归属 = 子代理的 usage 怎么记账？
 *
 *   单轨原则：**谁调用模型，谁记账**。
 *     - 子代理的每一轮模型调用由子 Loop 发起 → 记在子 LoopResult.usage；
 *     - 父的 LoopResult.usage 只含父自己的轮次——**刻意不合并**。
 *   理由（三条）：
 *     1. 合并会破坏「usage ↔ turns ↔ messages」的一致语义（父的
 *        usage 除以父的 turns 不再等于单轮平均成本）；
 *     2. 归因需要保留层级（哪次 spawn 烧了多少钱），合并即丢失结构；
 *     3. 聚合是展示层的问题——subagent_finished 事件携带 usage，
 *        可观测层（w14）消费事件做跨层级汇总；内核只管事实分账。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 与 skills 层的定位对照（两者都是「编排」，但正交）：
 *
 *              | Skill（w12）              | Sub-agent（w13）
 *   决定者     | 代码（resolveArgs 写死）   | 模型（子代理自己决定下一步）
 *   数据流     | N 个工具按固定顺序         | 未知轮次，可能无工具调用
 *   失败语义   | fail-fast（后续步骤不跑）  | partial（各任务独立结算）
 *   用例       | 审计要求高的固定流程       | 开放子任务（调研/写作/审查）
 *
 * 依赖方向：subagent/types.ts → config / types（全局）/ agent-loop 类型。
 * 本文件零逻辑——纯形状与文档；执行语义在 agent-tool / pool / orchestrator。
 */

import type { HarnessConfig } from '../config.ts';
import type { ToolErrorCode } from '../errors.ts';
import type { HookPipeline } from '../hooks/pipeline.ts';
import type { EventBus } from '../kernel/events.ts';
import type { PermissionGate } from '../permission/gate.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { LLMProvider, Usage } from '../types.ts';

// ===========================================================================
// §1 子代理定义（装配期的静态声明）
// ===========================================================================

/**
 * 子代理定义：一份「窄专员」的完整静态声明。
 * 与 agent-tool.ts 的 createAgentTool 配合：定义是数据，工具是它的运行时投影。
 */
export interface SubAgentDefinition {
  /**
   * 工具名（父模型 API 中可见的调用名）。
   * 与所有工具名共享同一命名空间——注册进父 ToolRegistry 时重名会被
   * config_error 拒绝（工具名是模型可见协议面，禁止偷偷覆盖）。
   */
  readonly name: string;
  /** 给父模型看的描述：「什么时候该派这个子代理」。模型靠它选择是否调用 */
  readonly description: string;
  /** 子代理的独立 system 提示词（隔离四层之层 2）——定义职责与输出格式 */
  readonly systemPrompt: string;
  /**
   * 工具子集（隔离四层之层 3）：子代理可访问的工具名白名单。
   * 缺省 = undefined 表示「继承父的全部工具」（谨慎使用——等于放弃了
   * 最小权限原则；教学演示里保留这个能力以观察两种形态的差异）。
   */
  readonly toolNames?: readonly string[];
  /**
   * 子循环的 maxTurns 覆盖。缺省用 config.subagent.maxTurns。
   * 同步在「浅拷贝 config」上生效——见 agent-tool.ts 的实现注释。
   */
  readonly maxTurns?: number;
  /**
   * 单任务超时覆盖（毫秒）。缺省用 config.subagent.taskTimeoutMs。
   * 快速检索类子代理可以调小（10s），写作类调大（120s）。
   */
  readonly timeoutMs?: number;
}

// ===========================================================================
// §2 编排输入（fan-out 的任务描述）
// ===========================================================================

/**
 * 一次 fan-out 中的单个任务：把 task 交给名为 agent 的子代理。
 * 「agent 引用」用名字而非对象引用：任务列表可以是配置/序列化产物，
 * 名字在运行期经目录解析——解析失败是结构化失败（见 TaskFailureReason）。
 */
export interface SubagentTaskSpec {
  readonly agent: string;
  readonly task: string;
}

// ===========================================================================
// §3 任务结果（编程接口的报告形状）
// ===========================================================================

/**
 * 子代理域的失败分类学（比 ToolErrorCode 更细的诊断维度）。
 *
 * 为什么需要两套码（TaskFailureReason 与 ToolErrorCode 并存）？
 *   - ToolErrorCode（5 值）是**给模型看的**：它是 ToolResult.error.code，
 *     词汇表必须极小且稳定（模型依赖它决定重试/换路）；
 *   - TaskFailureReason 是**给编排者与日志看的**：区分 max_turns 与
 *     provider 异常这类「模型不需要知道，但工程师必须一眼看懂」的
 *     归因维度。两者是不同消费者、不同精度的视图——刻意不合并。
 */
export type TaskFailureReason =
  | 'unknown_agent' // 任务引用的 agent 不在目录中（调用方输入错误）
  | 'input_error' // 任务本身不合法（如 task 为空串）
  | 'unknown_tool' // 子代理定义引用了未注册的工具（装配错误，预检时暴露）
  | 'timeout' // 内部协作式超时触发（子循环被真正取消）
  | 'max_turns' // 子循环达到轮次上限仍未完成任务
  | 'run_error'; // 子循环抛出致命异常（provider 故障 / 组装协议破坏）

/**
 * 单个任务的结算结果。判别联合：ok 字段决定其余字段存在性。
 *
 * partial 语义（与 skill 的 fail-fast 对照）：
 *   fan-out 中某任务失败**不影响**其他任务——各任务独立结算、
 *   各带各的失败原因。理由：fan-out 的子任务互不消费对方的输出
 *   （与 skill 的步骤链相反），一个失败不该株连其他。
 */
export type TaskOutcome =
  | {
      readonly ok: true;
      readonly agent: string;
      readonly task: string;
      /** 子代理的最终回答（父世界唯一可见的内容——隔离四层之层 4） */
      readonly summary: string;
      /** 独立记账的用量（见必答问题 ②） */
      readonly usage: Usage;
      /** 子循环实际消耗的轮次 */
      readonly turns: number;
    }
  | {
      readonly ok: false;
      readonly agent: string;
      readonly task: string;
      /** 给模型词汇表的错误码（若结果回给父模型） */
      readonly errorCode: ToolErrorCode;
      /** 给编排者/日志的精细归因（见 TaskFailureReason 的注释） */
      readonly reason: TaskFailureReason;
      readonly message: string;
    };

/** fan-out 的汇总报告（orchestrator 的产出） */
export interface SubagentRunReport {
  /** 按输入顺序结算（与完成顺序无关——并发不破坏可断言性） */
  readonly outcomes: readonly TaskOutcome[];
  readonly okCount: number;
  readonly failCount: number;
  /**
   * 成功任务的用量聚合（失败任务的 usage 在取消/异常路径不可得——
   * 这是已知缺口，见 agent-tool.ts 的演进点标注）。
   * 聚合只发生在报告层：内核记账仍是单轨分账（必答问题 ②）。
   */
  readonly totalUsage: Usage;
}

// ===========================================================================
// §4 装配依赖（createAgentTool / runSubagents 的输入）
// ===========================================================================

/**
 * 子代理装配依赖。
 *
 * 关键决策一：providerFactory 是**工厂**而不是实例。
 *   子代理需要一个**独立的 Provider 实例**：
 *     - FakeProvider：脚本游标是可变状态，共享实例会被并发子代理
 *       交错消费（你拿我的回合、我拿你的回合——完全不确定）；
 *     - 真实 Provider：HTTP 无状态，可返回单例（工厂每次返回同一实例，
 *       由装配方决定），但独立实例也无害（更利于限流隔离）。
 *   把决策权交给工厂：接口稳定，两种形态都表达得了。
 *
 * 关键决策二：deps 里的 hooks / permission 是**复用父的实例**（照传）。
 *   权限与 hook 是全局横切策略（审计、脱敏、熔断），子代理的工具执行
 *   同样必须过它们——「子代理免检」是一个危险的反模式（子代理恰恰是
 *   自主性最高、最需要约束的执行者）。工具子集已经是权限的第一道
 *   结构性收窄；hook 链是第二道。
 */
export interface SubAgentDeps {
  /** 父的全部工具（构建子集工具的来源） */
  readonly tools: ToolRegistry;
  /** hook 管道（子代理工具执行同样过链——见上注释） */
  readonly hooks: HookPipeline;
  /** 权限门（同上：横切策略不因执行者身份而豁免） */
  readonly permission: PermissionGate;
  /** 事件总线（subagent_* 事件与子世界内部事件共用同一总线） */
  readonly bus: EventBus;
  /** 全量配置（子代理读 subagent 域；子循环复用其余域） */
  readonly config: HarnessConfig;
  /**
   * 子代理 Provider 工厂：每个子代理**每次 run** 调用一次。
   * 「每次 run」而不是「每个定义」：Provider 实例的自然生命周期就是
   * 一次任务（FakeProvider 的脚本对应一次子查询的 N 个回合）。
   */
  readonly providerFactory: (agent: SubAgentDefinition) => LLMProvider;
  /** 时钟注入（默认 Date.now） */
  readonly now?: () => number;
}
