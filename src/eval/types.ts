/**
 * Eval 层类型 —— 场景、证据与断言的「事实形状」。
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 定位：把「harness 跑出来的一次行为」变成「可断言的证据」的最后一段路  │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * 数据流全景（runner.ts 的舞台）：
 *
 *   EvalScenario（纯数据：输入 + 剧本 + 覆盖 + 断言）
 *     → createCoreRig / createSessionRig（rig.ts / session-rig.ts：按
 *       scenario.session 分派——剥光外壳的内核装配 / 含 Session 的完整装配）
 *     → 真实跑一次 query → ScenarioEvidence（全部证据：终态/事件/请求/账本）
 *     → 每条断言 check(evidence) → undefined=过 / string=失败原因
 *     → ScenarioResult → EvalReport → renderEvalReport（人读）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三个哲学（对齐 docs/03 §5 的场景测试约定）：
 *
 * ① 「断言行为，不匹配文本」：
 *    断言工具调用序列 / 终止原因 / 错误码 / 事件发射——这些是**契约**；
 *    模型的自然语言输出是**自由发挥**，匹配文本既脆弱又无信息量。
 *    本层的 EvalAssertion 只接收结构化证据，从类型上就堵死「文本匹配」。
 *
 * ② 「失败收集，不 fail-fast」：
 *    断言返回失败原因字符串而非抛错——一个场景的全部断言都会执行，
 *    一次给出完整失败清单（缺了哪个工具、终止原因错成什么）。
 *    对照：Skill 是 fail-fast（流程语义），这里是审计语义——不同的失败哲学。
 *    极端情况（断言自身抛错）由 runner 兜底捕获并记为失败，不炸整个测试。
 *
 * ③ 「场景即数据」：
 *    EvalScenario 是纯数据 + 一组断言函数——评审时读一遍就能明白
 *    「这个场景在验什么」，不需要跟着控制流走。内置基准场景见
 *    builtin-scenarios.ts（同时是协议的最佳示例）。
 *
 * 依赖方向：eval/types.ts → 各模块的公开类型（config / kernel / llm /
 * subagent / observability / 全局 types）。eval 是「横切消费层」：
 * 依赖一切，不被一切依赖（没人 import eval 去干活——它只服务测试与演示）。
 */

import type { DeepPartial, HarnessConfig } from '../config.ts';
import type { LoopEvent, LoopResult } from '../kernel/agent-loop.ts';
import type { HarnessEvent } from '../kernel/events.ts';
import type { FakeTurn } from '../llm/fake-provider.ts';
import type { CostTracker } from '../observability/cost.ts';
import type { PermissionRule } from '../permission/rules.ts';
import type { ResumeInfo } from '../session/session-manager.ts';
import type { SubAgentDefinition } from '../subagent/types.ts';
import type { Hook, LLMRequest, Message, SessionState } from '../types.ts';

// ===========================================================================
// §1 证据（断言函数的输入）
// ===========================================================================

/**
 * 一次场景运行后的全部证据。
 * 为什么把这些都给断言？——断言的自由来自证据的完整；
 * 每个字段对应一类断言（设计对照见 assertions.ts 的六个 helper）：
 *   result     → 终止原因 / 轮次 / 最终用量
 *   loopEvents → 主世界工具序列（子世界事件不在这里——隔离的又一体现）
 *   events     → 全量总线事件（错误码 / 子代理 / 压缩 / usage_recorded…）
 *   requests   → 发给模型的上下文原样（上下文组装类断言）
 *   cost       → 计价账本（成本维度断言；未开启 costTracking 时为 undefined）
 */
export interface ScenarioEvidence {
  /** 主循环终态。契约上总有值；undefined 仅防御（run 未产出 completed 信封） */
  readonly result: LoopResult | undefined;
  /** 主世界的 LoopEvent 流（UI 面向；tool_started 序列从这里取） */
  readonly loopEvents: readonly LoopEvent[];
  /** 全量 HarnessEvent（含子世界——派生 queryId 可分辨） */
  readonly events: readonly HarnessEvent[];
  /** 主 Provider 收到的全部 LLMRequest（上下文断言用） */
  readonly requests: readonly LLMRequest[];
  /** 计价账本（config.observability.costTracking 关闭时为 undefined） */
  readonly cost: CostTracker | undefined;
  /** rig 使用的会话 / query 标识（确定性的固定字符串——见 rig.ts） */
  readonly sessionId: string;
  readonly queryId: string;
  /** 会话面证据（仅 Session Rig 提供；Core Rig 保持 undefined——可分辨） */
  readonly session?: SessionEvidence;
}

/**
 * 会话面证据（Session Rig 追加——见 session-rig.ts）。
 * 每个字段对应一类会话断言（assertSessionState / assertResumeFilled /
 * 配对完整性内联断言）：
 *   resume            → 恢复流程报告（未触发时为 undefined——状态门控的负路径证据）
 *   stateAfter        → run 结束后的会话状态（状态机终态断言）
 *   persistedMessages → 落盘历史快照（配对完整性 / 历史连续性断言）
 */
export interface SessionEvidence {
  readonly resume: ResumeInfo | undefined;
  readonly stateAfter: SessionState | undefined;
  readonly persistedMessages: readonly Message[];
}

// ===========================================================================
// §2 断言协议
// ===========================================================================

/**
 * 一条行为断言。
 * 契约：返回 undefined = 通过；返回字符串 = 失败原因（人读的完整描述）。
 * 为什么不抛错？——收集式语义（哲学 ②）：抛错会终止同场景后续断言。
 */
export interface EvalAssertion {
  readonly name: string;
  readonly check: (evidence: ScenarioEvidence) => string | undefined;
}

// ===========================================================================
// §3 场景定义
// ===========================================================================

/** 场景定义：纯数据——rig 用它装配，runner 用它断言（「场景即数据」哲学 ③） */
export interface EvalScenario {
  readonly name: string;
  readonly description: string;
  /** 用户输入（送进 Loop 的那句话） */
  readonly input: string;
  /** 主循环的 FakeProvider 剧本 */
  readonly script: readonly FakeTurn[];
  /** 子代理的独立剧本（键 = 代理名；缺省代理拿到空剧本——耗尽即报错，防呆） */
  readonly subagentScripts?: Readonly<Record<string, readonly FakeTurn[]>>;
  /** 要注册进父世界的子代理定义（缺省 = 场景不涉及子代理） */
  readonly subagents?: readonly SubAgentDefinition[];
  /**
   * 追加到默认 hook 集的自定义 hook（默认集见 hooks/builtin）。
   * 用途：注入「改写类」能力（如内置集没有消费者的 modify_input）——
   * 同 priority 时按注册顺序（默认集先、追加后，稳定排序由管道保证）。
   */
  readonly hooks?: readonly Hook[];
  /** 权限规则表（规则优先于风险策略——PermissionGate 的决策顺序，见 rules.ts） */
  readonly permissionRules?: readonly PermissionRule[];
  /**
   * 注册 spawn_subagents 编排工具（fan-out 场景；需同时声明 subagents）。
   * 缺省 false = 子代理仅以「单派工具」形态注册（registerAgentTools）。
   */
  readonly enableOrchestrator?: boolean;
  /** 配置覆盖（DeepPartial——同 defineConfig 语义） */
  readonly overrides?: DeepPartial<HarnessConfig>;
  /**
   * 是否自动批准权限确认。
   * 缺省 false = 无确认通道 → fail-safe 拒绝——这是「非交互环境」的真实
   * 语义，也是权限类场景的断言素材（对照：CLI 交互仅把 handler 换成询问）。
   */
  readonly autoApprovePermissions?: boolean;
  /**
   * 会话预置装置（存在 → runner 选用 Session Rig——见 session-rig.ts）。
   * 语义：模拟「上一个进程留下的现场」——装配时把 messages/state/checkpoint
   * 写入临时 SQLite 并**重开连接**（跨进程语义），run 时先按状态门控触发
   * resumeSession（interrupted/processing），再走 runQuery 正常续问。
   */
  readonly session?: SessionPreload;
  /** 行为断言列表（可为空——纯证据收集型场景，如 lab 幕 H 的账本演示） */
  readonly assertions: readonly EvalAssertion[];
}

/**
 * 会话预置（见 EvalScenario.session）。
 * 这三项就是「崩溃现场」的全部要素：消息历史（可含半截批调用）、
 * 检查点元数据、状态机的停留位置。
 */
export interface SessionPreload {
  /** 预置的消息历史（崩溃时刻库里的全部消息——可含「已宣布无结果」的调用） */
  readonly messages: readonly Message[];
  /** 预置状态（缺省 'interrupted'；'processing' = 崩溃残留，恢复时会被修正） */
  readonly state?: SessionState;
  /** 检查点记录的轮次（缺省 1；影响 ResumeInfo.turn 与快照元数据） */
  readonly checkpointTurn?: number;
}

// ===========================================================================
// §4 结果与报告
// ===========================================================================

/** 单场景结果 */
export interface ScenarioResult {
  readonly name: string;
  readonly description: string;
  readonly ok: boolean;
  /** 失败清单（每条 = `[断言名] 失败原因`）；ok=true 时为空数组 */
  readonly failures: readonly string[];
  /** 摘要（报告一行读完全貌：终止原因 / 轮次 / 主世界工具序列） */
  readonly summary: {
    readonly stopReason: string | undefined;
    readonly turns: number | undefined;
    readonly toolCalls: readonly string[];
  };
}

/** 批量报告 */
export interface EvalReport {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly durationMs: number;
  readonly results: readonly ScenarioResult[];
}
