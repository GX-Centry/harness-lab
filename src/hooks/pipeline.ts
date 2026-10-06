/**
 * HookPipeline —— 横切关注点的执行管道。
 *
 * 执行模型（对齐 ADR-009）：
 *   1. 构造时按 priority 稳定排序一次（数字小者先跑；ES2019+ 的 sort 保证稳定，
 *      同优先级按注册顺序——顺序可预测是审计与测试的前提）；
 *   2. run(payload, ctx) 按事件名路由到声明关心该事件的 hook；
 *   3. 每个 hook 单独 try/catch：**hook 失败不阻断主流程**，
 *      错误进事件流（hook_error）后继续跑下一个——观测组件不能成为可用性单点；
 *   4. 5 种 outcome 的流转语义（插槽值的更新规则）：
 *        continue      → 什么都不变
 *        modify_input  → 更新「当前输入」，后续 hook 与执行链看到新值
 *        modify_result → 更新「当前结果」
 *        block         → 立即终止管道，blocked=reason（调用方决定如何拒绝）
 *        skip          → 终止管道但不阻断（「后续 hook 对此调用不适用」）
 *
 * 生产/消费关系：
 *   Dispatcher 在四步链的两个位置调用本管道（tool_call_before / tool_call_after）；
 *   管道自身通过注入的 EventBus 上报 hook_invoked / hook_outcome / hook_error。
 *
 * 依赖方向：hooks/pipeline.ts → types.ts / kernel/events.ts。
 */

import type { EventBus } from '../kernel/events.ts';
import type { Hook, HookContext, HookOutcomeKind, HookPayload, ToolResult } from '../types.ts';

// ===========================================================================
// §1 运行结果
// ===========================================================================

/** 管道运行结果：插槽的最终值 + 阻断信息 */
export interface PipelineOutcome {
  /** 被 block 时的原因（调用方据此构造拒绝结果）；未阻断为 undefined */
  readonly blocked: { readonly reason: string } | undefined;
  /** 管道结束时的「当前输入」（可能被 modify_input 更新过） */
  readonly input: unknown;
  /** 管道结束时的「当前结果」（仅 post 阶段有意义，可能被 modify_result 更新过） */
  readonly result: ToolResult | undefined;
}

export interface HookPipelineOptions {
  readonly hooks: readonly Hook[];
  /** 事件上报通道（可选：纯单元测试可以不接总线） */
  readonly bus?: EventBus;
}

// ===========================================================================
// §2 管道实现
// ===========================================================================

export class HookPipeline {
  private readonly sorted: readonly Hook[];
  private readonly bus: EventBus | undefined;

  constructor(options: HookPipelineOptions) {
    // 稳定排序：priority 升序；同 priority 保持注册顺序
    this.sorted = [...options.hooks].sort((a, b) => a.priority - b.priority);
    this.bus = options.bus;
  }

  /**
   * 全部已注册 hook（按执行顺序——priority 升序、同级按注册序）。
   * 只读视图：供 /hooks 命令与诊断展示（「这个装配挂了哪些横切逻辑」）。
   */
  get registeredHooks(): readonly Hook[] {
    return this.sorted;
  }

  /**
   * 运行一次管道。
   *
   * @param payload 调用方构造的载荷（含 event / sessionId / queryId / toolCall 等；
   *                其中 input 与 result 是**初始值**，会被 hook 的修改逐步更新）
   * @param ctx     hook 运行环境（now / log 注入）
   */
  async run(payload: HookPayload, ctx: HookContext): Promise<PipelineOutcome> {
    let currentInput = payload.input;
    let currentResult = payload.result;

    for (const hook of this.sorted) {
      if (!hook.events.includes(payload.event)) continue;

      this.bus?.emit({
        type: 'hook_invoked',
        hookName: hook.name,
        event: payload.event,
        sessionId: payload.sessionId,
        queryId: payload.queryId,
      });

      let outcomeKind: HookOutcomeKind;
      try {
        // 每个 hook 收到「当前最新值」的快照（前一个 hook 的修改已生效）
        const outcome = await hook.handler(
          { ...payload, input: currentInput, result: currentResult },
          ctx,
        );
        outcomeKind = outcome.kind;

        switch (outcome.kind) {
          case 'continue':
            break;
          case 'modify_input':
            currentInput = outcome.input;
            break;
          case 'modify_result':
            currentResult = outcome.result;
            break;
          case 'block':
            this.reportOutcome(hook.name, payload, outcomeKind);
            return { blocked: { reason: outcome.reason }, input: currentInput, result: currentResult };
          case 'skip':
            this.reportOutcome(hook.name, payload, outcomeKind);
            return { blocked: undefined, input: currentInput, result: currentResult };
          default: {
            // 穷尽检查：新增 HookOutcome 成员而忘记处理 → 编译期报错
            const unhandled: never = outcome;
            void unhandled;
          }
        }
      } catch (raw) {
        // hook 自身报错：记录 + 继续（ADR-009）。注意 log 失败也不得外溢——
        // emit 的订阅者隔离由 EventBus 保证。
        const message = raw instanceof Error ? raw.message : String(raw);
        this.bus?.emit({
          type: 'hook_error',
          hookName: hook.name,
          event: payload.event,
          message,
          sessionId: payload.sessionId,
          queryId: payload.queryId,
        });
        continue;
      }

      this.reportOutcome(hook.name, payload, outcomeKind);
    }

    return { blocked: undefined, input: currentInput, result: currentResult };
  }

  private reportOutcome(hookName: string, payload: HookPayload, kind: HookOutcomeKind): void {
    this.bus?.emit({
      type: 'hook_outcome',
      hookName,
      event: payload.event,
      kind,
      sessionId: payload.sessionId,
      queryId: payload.queryId,
    });
  }
}
