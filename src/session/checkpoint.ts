/**
 * 检查点工具集 —— 「恢复的最小充分信息」的定义与修复（纯函数，零 IO）。
 *
 * 恢复语义的核心（对齐 03-module-guide §2.8 与 ADR 待决清单）：
 *   崩溃后从最近 checkpoint 继续，**不重放已完成的工具**：
 *     - 已完成调用的结果就在快照消息里（tool 消息与 assistant 调用配对完整）；
 *     - 未完成的调用（assistant 已宣布、结果缺失）补一条「因中断未完成」的
 *       占位结果——把选择权交还模型（重新发起 or 换一条路）。
 *   这是 AgentLoop 取消协议（agent-loop 决策 ⑤）在恢复场景的**镜像**：
 *   「崩溃」被当作「取消」处理。为什么是占位而不是自动重放？——
 *   重放有重复副作用的风险（写文件、发请求、扣款都可能执行两遍），
 *   而占位是安全的：模型看到「上次没做成」后自行决定是否重做。
 *
 * 为什么 pending 从消息推导、而不是在 checkpoint 里单独存字段？
 *   单一事实来源：messages 的配对关系是权威表述；派生的 pending 列表一旦
 *   与它不一致（写入遗漏 / 版本漂移）就是恢复逻辑的灾难。推导是纯函数、
 *   零成本、且天然幂等——补过占位的快照再次推导必得空集，repeated resume
 *   不会重复补位（这是「至少一次恢复」安全的根基）。
 *
 * 依赖方向：session/checkpoint.ts → types.ts（全仓库最浅依赖，可独立测试）。
 */

import type { Message } from '../types.ts';
import { toolMessage } from '../types.ts';

// ===========================================================================
// §1 未完成调用（pending）的推导
// ===========================================================================

/** 一条「已宣布但缺结果」的工具调用（name 从发起它的 assistant 消息中取得） */
export interface PendingToolCall {
  readonly id: string;
  readonly name: string;
}

/**
 * 推导历史中所有「已宣布、无结果」的工具调用。
 *
 * 算法：一次线性扫描——
 *   1. 遇 assistant(tool_calls)：把每个调用记入「在途表」（Map 保留插入序）；
 *   2. 遇 tool 消息：从在途表按 toolCallId 核销；
 *   3. 扫描结束后仍在表中者 = 未完成。
 *
 * 边界说明：
 *   - 正常情况下（Loop 保证配对）本函数在「每轮一致点」必返回空——
 *     非空恰恰是「进程在工具执行中被杀」的特征信号；
 *   - 顺序按调用被宣布的时间（Map 迭代序），保证补位消息与宣布顺序一致。
 */
export function pendingToolCallsOf(messages: readonly Message[]): PendingToolCall[] {
  const inflight = new Map<string, string>(); // toolCallId → toolName

  for (const message of messages) {
    if (message.role === 'assistant' && message.toolCalls !== undefined) {
      for (const call of message.toolCalls) {
        inflight.set(call.id, call.name);
      }
    }
    if (message.role === 'tool') {
      inflight.delete(message.toolCallId);
    }
  }

  const pending: PendingToolCall[] = [];
  for (const [id, name] of inflight) {
    pending.push({ id, name });
  }
  return pending;
}

// ===========================================================================
// §2 中断补位（恢复的唯一「写」操作）
// ===========================================================================

/** 补位消息的固定文案模板（reason 由调用方传入，方便测试与本地化调整） */
export const INTERRUPTED_TOOL_REASON =
  '（该调用在上次运行中因进程中断而未完成，结果已丢失；如需该结果请重新发起调用）';

export interface FillInterruptedResult {
  /** 补齐后的消息数组（新数组——输入永不被修改） */
  readonly messages: Message[];
  /** 本次实际补位的调用（空数组 = 无需修复，天然幂等） */
  readonly filled: readonly PendingToolCall[];
}

/**
 * 为所有未完成的工具调用补占位结果。
 *
 * 位置约定：占位消息**追加到数组末尾**（按宣布顺序）。
 * 配对合法性依据是 toolCallId 而非相邻性（规范形的约定，见 types.ts）；
 * 真实 Provider 对「tool 结果必须紧跟其调用」有各自的排版要求，那是
 * llm/*-provider.ts 适配层的翻译职责——恢复流程只管配对完整。
 *
 * 纯函数约定：返回新数组；filled 已非空的历史再次调用必得 filled=[]（幂等）。
 */
export function fillInterruptedToolResults(
  messages: readonly Message[],
  reason: string = INTERRUPTED_TOOL_REASON,
): FillInterruptedResult {
  const pending = pendingToolCallsOf(messages);
  if (pending.length === 0) {
    return { messages: [...messages], filled: [] };
  }
  const placeholders = pending.map((call) => toolMessage(call.id, call.name, reason));
  return { messages: [...messages, ...placeholders], filled: pending };
}
