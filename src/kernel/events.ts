/**
 * 事件流与 EventBus —— 可观测性的底座。
 *
 * 核心原则：「只读广播，不参与控制流」。
 *   - 任何模块都可以 emit / on，但事件**不携带决策能力**：
 *     控制流的走向靠返回值（HookOutcome / ToolResult / Loop 判断），
 *     事件只用来「记录发生了什么」。这条边界让观测逻辑永远无法改变系统行为——
 *     否则「可观测组件」会成为「可用性单点 + 难以推演的隐式逻辑」。
 *
 * 生产/消费全景（每个事件下方注释标注）：
 *   生产者：kernel(Loop/Dispatcher) / llm / context / session / memory / commands / skills / subagent
 *   消费者：Tracer（全量落盘）/ CostTracker（usage_*）/ CLI（渲染进度）/ 测试（行为断言）
 *
 * 确定性约定（铁律 2）：
 *   - 时间通过构造参数注入（now），测试里可产出完全可预测的 ts；
 *   - seq 单调递增，事件顺序可断言；
 *   - 事件对象浅冻结——分发后的篡改会被严格模式当场拒绝。
 *
 * 依赖方向：kernel/events.ts → types.ts → errors.ts。
 */

import type { HarnessErrorCode, ToolErrorCode } from '../errors.ts';
import type {
  HookEventName,
  HookOutcomeKind,
  LoopStopReason,
  Message,
  PermissionDecision,
  RiskLevel,
  SessionState,
  StopReason,
  Usage,
} from '../types.ts';

// ===========================================================================
// §1 事件定义（全链路事件流）
// ===========================================================================

/** 所有事件的公共信封：序号 + 时间戳 + 可选关联维度 */
interface HarnessEventBase {
  /** 单调递增序号（从 1 开始）：事件顺序的确定性锚点 */
  readonly seq: number;
  /** 毫秒时间戳：默认 Date.now()，测试注入固定时钟 */
  readonly ts: number;
  /** 会话维度：跨模块关联同一次会话的全部事件 */
  readonly sessionId?: string;
  /** Query 维度：关联「一次用户输入引发的全部活动」（含其衍生轮次） */
  readonly queryId?: string;
}

/**
 * 全链路事件联合。分组 = 系统生命周期阶段。
 * 命名约定：名词_过去式（发生过的事实），例如 tool_finished。
 * 演进约定（接口先行）：skills/subagent 事件已在类型中声明，
 * 对应模块（w12/w13）实现后开始生产——union 提前稳定，避免实现期反复改事件类型。
 */
export type HarnessEvent =
  // ---- 会话生命周期（生产者：session）----
  | (HarnessEventBase & { type: 'session_created' })
  | (HarnessEventBase & { type: 'session_resumed'; checkpointId: string })
  | (HarnessEventBase & { type: 'session_state_change'; from: SessionState; to: SessionState })

  // ---- 查询生命周期（生产者：kernel/agent-loop）----
  // 隐私约定：输入原文不入事件（最小化原则），只记长度；需要原文走 session 存储
  | (HarnessEventBase & { type: 'query_start'; inputLength: number })
  | (HarnessEventBase & { type: 'query_end'; stopReason: LoopStopReason; turns: number; usage: Usage })

  // ---- 模型调用（生产者：kernel / llm-retry 包装）----
  | (HarnessEventBase & {
      type: 'llm_request';
      model: string;
      messageCount: number;
      toolCount: number;
      approxInputTokens: number;
    })
  | (HarnessEventBase & {
      type: 'llm_response';
      model: string;
      stopReason: StopReason;
      usage: Usage;
      toolCallCount: number;
      latencyMs: number;
    })
  | (HarnessEventBase & {
      type: 'llm_retry';
      attempt: number;
      maxAttempts: number;
      code: HarnessErrorCode;
      delayMs: number;
    })

  // ---- 工具链（生产者：kernel/dispatcher）----
  | (HarnessEventBase & { type: 'tool_call_assembled'; toolCallId: string; name: string; parseOk: boolean })
  | (HarnessEventBase & { type: 'hook_invoked'; hookName: string; event: HookEventName })
  | (HarnessEventBase & { type: 'hook_outcome'; hookName: string; event: HookEventName; kind: HookOutcomeKind })
  | (HarnessEventBase & { type: 'hook_error'; hookName: string; event: HookEventName; message: string })
  | (HarnessEventBase & {
      type: 'permission_decision';
      toolName: string;
      risk: RiskLevel;
      decision: PermissionDecision;
      reason: string;
    })
  | (HarnessEventBase & { type: 'tool_started'; toolCallId: string; name: string })
  | (HarnessEventBase & {
      type: 'tool_finished';
      toolCallId: string;
      name: string;
      ok: boolean;
      errorCode?: ToolErrorCode;
      durationMs: number;
    })

  // ---- 上下文（生产者：context）----
  | (HarnessEventBase & {
      type: 'context_built';
      totalTokens: number;
      layerTokens: Readonly<Record<string, number>>;
      compressed: boolean;
    })
  | (HarnessEventBase & { type: 'context_compressed'; level: number; droppedMessages: number; droppedTokens: number })

  // ---- 持久化（生产者：session）----
  | (HarnessEventBase & { type: 'message_persisted'; role: Message['role'] })
  | (HarnessEventBase & { type: 'checkpoint_saved'; checkpointId: string; turn: number })

  // ---- 记忆（生产者：memory）----
  | (HarnessEventBase & { type: 'memory_retrieved'; count: number; topScore: number })
  | (HarnessEventBase & { type: 'memory_written'; recordId: string; kind: string })

  // ---- 成本（生产者：observability/cost）----
  | (HarnessEventBase & { type: 'usage_recorded'; model: string; usage: Usage; estimatedCostUsd: number })

  // ---- 命令（生产者：commands）----
  | (HarnessEventBase & { type: 'command_invoked'; command: string })
  | (HarnessEventBase & { type: 'command_finished'; command: string; ok: boolean; durationMs: number })

  // ---- 技能（生产者：skills，w12 实现后开始生产）----
  | (HarnessEventBase & { type: 'skill_started'; skill: string })
  | (HarnessEventBase & { type: 'skill_finished'; skill: string; ok: boolean; durationMs: number })

  // ---- 子代理（生产者：subagent，w13 实现后开始生产）----
  | (HarnessEventBase & { type: 'subagent_started'; subagent: string; taskLength: number })
  | (HarnessEventBase & { type: 'subagent_finished'; subagent: string; ok: boolean; usage?: Usage })

  // ---- 系统（生产者：任意模块的兜底 catch / HookContext.log 桥接）----
  | (HarnessEventBase & { type: 'error'; code: HarnessErrorCode; message: string; where?: string })
  | (HarnessEventBase & { type: 'log'; level: 'info' | 'warn' | 'error'; message: string });

/** 事件名的字面量联合（订阅路由的键） */
export type EventName = HarnessEvent['type'];

// ===========================================================================
// §2 分发输入类型（教学点：分配式条件类型）
// ===========================================================================

/**
 * 分配式 Omit：对联合类型「逐个成员」应用 Omit，再重新联合。
 *
 * 为什么不能直接 `Omit<HarnessEvent, 'seq' | 'ts'>`？
 *   直接的 Omit 等价于对联合做 keyof——keyof 联合 = 成员键的**交集**，
 *   结果只剩公共字段，所有具体事件字段（toolName、usage...）全部丢失。
 *   `T extends unknown ? ... : never` 让条件类型对联合成员逐个分配，
 *   才能得到「保留每个成员自有字段、仅去掉 seq/ts」的联合。
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * emit 的输入形状：seq/ts 由 EventBus 补全（生产者不该手写时间戳），
 * 其余字段即事件的完整定义。
 */
export type HarnessEventInput = DistributiveOmit<HarnessEvent, 'seq' | 'ts'>;

// ===========================================================================
// §3 EventBus 实现
// ===========================================================================

export type EventHandler = (event: HarnessEvent) => void;

/** 订阅键：具体事件名 或 '*'（通配，收全部事件——Tracer 等观测消费者用） */
export type SubscriptionKey = EventName | '*';

export interface EventBusOptions {
  /** 时钟注入：默认 Date.now；测试注入 () => 0 得到可预测的 ts */
  now?: () => number;
  /**
   * 订阅者异常回调（如写入 Tracer 的警告日志）。
   * 缺省时订阅者异常被静默吞掉——「观测失败绝不炸主流程」是默认立场。
   */
  onSubscriberError?: (error: unknown, event: HarnessEvent) => void;
}

/**
 * 同步事件总线。设计取舍：
 *   - **同步分发**：emit 返回时全部订阅者已执行完。理由：教学项目的事件量小，
 *     同步让「事件顺序」与「主流程顺序」严格一致，可断言性最强；
 *     高频场景（真实生产的遥测）应改为队列 + 批量落盘——这是明确的演进点。
 *   - **异常隔离**：单个订阅者抛错不影响其他订阅者与主流程（对齐 ADR-009 精神：
 *     可观测组件不能成为可用性单点）。错误走 onSubscriberError 回调报告。
 *   - **退订函数**：on() 返回退订闭包而非配对 off(key, handler)——
 *     杜绝「退订时参数写错导致监听泄漏」这类经典 bug。
 */
export class EventBus {
  private seq = 0;
  private readonly handlers = new Map<SubscriptionKey, Set<EventHandler>>();
  private readonly now: () => number;
  private readonly onSubscriberError: ((error: unknown, event: HarnessEvent) => void) | undefined;

  constructor(options: EventBusOptions = {}) {
    this.now = options.now ?? Date.now;
    this.onSubscriberError = options.onSubscriberError;
  }

  /** 已分发事件总数（测试断言进度用；与最后一个事件的 seq 一致） */
  get emittedCount(): number {
    return this.seq;
  }

  /**
   * 订阅事件。返回退订函数：
   *   const off = bus.on('tool_finished', handler);
   *   off(); // 退订
   */
  on(key: SubscriptionKey, handler: EventHandler): () => void {
    let set = this.handlers.get(key);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(key, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  /**
   * 分发事件。行为契约：
   *   1. 补全 seq（单调 +1）与 ts（注入时钟）；
   *   2. 浅冻结事件——分发后篡改在严格模式立即报错；
   *   3. 先通知具体类型的订阅者，再通知 '*'（通配观测放最后，减少对主路径的干扰）；
   *   4. 订阅者异常被隔离，绝不向外抛——调用方不需要（也不应该）try/catch。
   */
  emit(input: HarnessEventInput): HarnessEvent {
    this.seq += 1;
    // 断言说明：input 是「分配式 Omit」联合，展开后 TS 无法自动还原为
    // HarnessEvent 联合（交叉类型重建不在类型系统的推理范围内），
    // 这里由 emit 的行为契约（补全 seq/ts）保证断言的正确性。
    const event = Object.freeze({ ...input, seq: this.seq, ts: this.now() }) as HarnessEvent;
    this.dispatchTo(this.handlers.get(event.type), event);
    this.dispatchTo(this.handlers.get('*'), event);
    return event;
  }

  /**
   * 清空全部订阅。用途：长驻进程里「重载插件/热更新」时先清再注册。
   * （测试隔离的常规做法是每个用例新建 EventBus，并不依赖这个方法。）
   */
  clear(): void {
    this.handlers.clear();
  }

  /** 单组订阅者的隔离分发：逐个 try/catch，快照遍历（允许 handler 内部退订/订阅） */
  private dispatchTo(handlers: Set<EventHandler> | undefined, event: HarnessEvent): void {
    if (handlers === undefined || handlers.size === 0) return;
    for (const handler of [...handlers]) {
      try {
        handler(event);
      } catch (error) {
        if (this.onSubscriberError === undefined) continue;
        try {
          this.onSubscriberError(error, event);
        } catch {
          // 错误处理器自身也抛错 → 最终静默。观测链路不允许炸掉主流程。
        }
      }
    }
  }
}
