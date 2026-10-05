/**
 * LangGraph 对照层 · 运行入口 —— 把图跑成「与 AgentLoop 同契约」的一次 query。
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 为什么要 runner：对照实验要有「同一种度量」                            │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * AgentLoop.run(input, history, ctx) → LoopResult
 * runLangGraphQuery(options, input, history, ctx) → LoopResult（同一个类型！）
 *
 * 输入同形、输出同形——测试才能对两条宿主做逐字段断言（turns/usage/
 * finalMessage/工具轨迹），而不是「各测各的」。
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 取消路径：同一个语义，两个时点的实现方式                                │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * 「工具执行到一半被取消」在本项目里有硬协议约束（对齐 Loop 决策 ⑤）：
 * assistant(tool_calls) 与 tool(result) 必须配对完整，否则历史不可用于
 * 下一轮请求。两条宿主的达成方式不同：
 *
 *   我们的 AgentLoop：**取消当下**在内存里补占位结果（catch AbortError
 *     后为「当前 + 剩余」调用 push 占位）——因为 Loop 是状态的所有者；
 *
 *   本 runner：**恢复时**从最近 checkpoint 读回状态再补（fillInterrupted
 *     ToolResults——复用 session/checkpoint.ts 的纯函数）。因为取消异常
 *     穿过 LangGraph 时，状态已不在调用栈上——恢复只能走 checkpointer。
 *
 * 对照结论（也是本层最有教学价值的一行）：**LangGraph 提供 checkpoint
 * 基础设施，但「中断配对补位」这条业务语义仍然要自己写**——框架送的是
 * 执行恢复的「管道」，不是你这个领域的「协议完整性」。复用的
 * fillInterruptedToolResults 恰好来自我们自己的 session 模块。
 *
 * checkpoint 的时间线（abort 恢复为什么可行）：
 *   super-step#1（model 节点完成）→ checkpoint 存入 assistant(tool_calls)
 *   super-step#2（tools 节点执行中）← 取消发生在这里
 *   → getState 读回最新 checkpoint（尾条是带 tool_calls 的 assistant）
 *   → fillInterruptedToolResults 推导 pending → 补占位 → 配对完整 ✓
 */

import { MemorySaver } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import type { HarnessConfig } from '../../config.ts';
import { isAbortError } from '../../errors.ts';
import type { Dispatcher } from '../../kernel/dispatcher.ts';
import type { LoopContext, LoopResult } from '../../kernel/agent-loop.ts';
import { fillInterruptedToolResults } from '../../session/checkpoint.ts';
import type { ToolRegistry } from '../../tools/registry.ts';
import type { AssistantMessage, LLMProvider, Message } from '../../types.ts';
import { userMessage } from '../../types.ts';
import { createLoopGraph } from './graph.ts';
import type { LoopGraphState } from './graph.ts';

// ===========================================================================
// §1 选项
// ===========================================================================

export interface LangGraphRunnerOptions {
  readonly provider: LLMProvider;
  readonly dispatcher: Dispatcher;
  readonly registry: ToolRegistry;
  readonly config: HarnessConfig;
  /**
   * checkpoint 存储：undefined = 缺省 MemorySaver（abort 恢复可用）；
   * null = 显式不挂（abort 时直接向上抛，用于对照「无基建版本的差异」）。
   */
  readonly checkpointer?: BaseCheckpointSaver | null;
}

// ===========================================================================
// §2 运行入口
// ===========================================================================

/**
 * 运行一次 query（LangGraph 宿主），返回与 AgentLoop 同形的 LoopResult。
 * 线程 id 用 ctx.queryId：每次 query 独立时间线（不跨 query 复用 checkpoint）。
 */
export async function runLangGraphQuery(
  options: LangGraphRunnerOptions,
  input: string,
  history: readonly Message[],
  ctx: LoopContext,
): Promise<LoopResult> {
  const checkpointer =
    options.checkpointer === undefined ? new MemorySaver() : options.checkpointer;
  const graph = createLoopGraph({
    provider: options.provider,
    dispatcher: options.dispatcher,
    registry: options.registry,
    config: options.config,
    ctx,
    checkpointer,
  });

  const runConfig = { configurable: { thread_id: ctx.queryId } };
  const initial: LoopGraphState = {
    // 对齐 Loop 的起手式：历史 + 本轮 user 消息（system 注入由调用方在 history 里完成）
    messages: [...history, userMessage(input)],
    turns: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
  };

  try {
    const final = await graph.invoke(initial, runConfig);
    return toLoopResult(final);
  } catch (raw) {
    if (!isAbortError(raw) || checkpointer === null) throw raw;

    // ---- 取消恢复路径：从最近 checkpoint 读回 + 配对补位（见文件头注释）----
    let state: LoopGraphState;
    try {
      const snapshot = await graph.getState(runConfig);
      const values = snapshot.values as Partial<LoopGraphState>;
      state =
        values.messages !== undefined
          ? {
              messages: values.messages,
              turns: values.turns ?? 0,
              usage: values.usage ?? { inputTokens: 0, outputTokens: 0 },
            }
          : initial; // 无 checkpoint（首轮内取消）：保持初始输入——半截轮次不入历史
    } catch {
      state = initial; // 恢复机制本身失败时的最后兜底
    }
    const { messages } = fillInterruptedToolResults(state.messages);
    return {
      stopReason: 'aborted',
      turns: state.turns,
      usage: state.usage,
      messages,
      finalMessage: lastAssistantOf(messages),
    };
  }
}

// ===========================================================================
// §3 内部函数
// ===========================================================================

/**
 * 把图的终态翻译为 LoopResult。
 * 终止原因推导（依据见 graph.ts 文件头的轨迹分析）：
 *   - 末条 assistant 无 toolCalls → 模型自然收尾 → completed；
 *   - 末条 assistant 有 toolCalls 却结束 → 只可能是「tools 后 turns>=M」→ max_turns。
 */
function toLoopResult(values: LoopGraphState): LoopResult {
  const finalMessage = lastAssistantOf(values.messages);
  const pendingToolCalls = (finalMessage?.toolCalls?.length ?? 0) > 0;
  return {
    stopReason: pendingToolCalls ? 'max_turns' : 'completed',
    turns: values.turns,
    usage: values.usage,
    messages: values.messages,
    finalMessage,
  };
}

/** 最后一条 assistant 消息（aborted 时可能是半截以外的完整消息，可能 undefined） */
function lastAssistantOf(messages: readonly Message[]): AssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message !== undefined && message.role === 'assistant') {
      return message as AssistantMessage;
    }
  }
  return undefined;
}
