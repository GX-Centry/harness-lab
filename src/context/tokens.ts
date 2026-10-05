/**
 * Context 层的 token 计量 —— 「预算」可信的前提是「计量」稳定可控。
 *
 * 两个关键约定：
 *   1. 只计量「可估算的部分」（文本 + 工具参数 JSON），结构开销用固定余量
 *      补偿（见 MESSAGE_OVERHEAD_TOKENS 的理由）；
 *   2. TokenCounter 是从外部注入的函数而非全局单例——Fake 与真实 Provider
 *      各有各的 tokenizer，预算判断必须与「即将调用的 Provider」用同一把尺子
 *      （装配层负责注入同一个 counter）。
 *
 * 依赖方向：context/tokens.ts → types.ts（纯函数，零 IO）。
 */

import type { Message } from '../types.ts';

/**
 * token 计数函数（Provider 注入——countTokens 是 LLMProvider 接口的成员）。
 * 抽成独立类型让 context 模块不必依赖整个 LLMProvider 接口（最小依赖面）。
 */
export type TokenCounter = (text: string) => number;

/**
 * 每条消息的结构开销补偿（tokens）。
 *
 * 为什么需要固定余量：countTokens 只吃「内容文本」，但真实请求里每条消息
 * 还有 role 标签、分隔符、tool_call 的结构包装等序列化开销。精确建模需要
 * 逐 provider 适配（收益低、维护贵）；固定 4 的直觉：一条消息的结构包装
 * 大约就是几个 token，方向正确就能让预算判断「不乐观冒进」——宁可略低估
 * 可用空间，也不要发出后被 provider 意外截断。
 */
export const MESSAGE_OVERHEAD_TOKENS = 4;

/** 单条消息的 token 占用（内容 + toolCalls 的参数 JSON + 结构开销） */
export function messageTokens(message: Message, count: TokenCounter): number {
  let total = count(message.content) + MESSAGE_OVERHEAD_TOKENS;
  if (message.role === 'assistant' && message.toolCalls !== undefined) {
    for (const call of message.toolCalls) {
      total += count(call.argsRaw);
    }
  }
  return total;
}

/** 一组消息的 token 合计 */
export function messagesTokens(messages: readonly Message[], count: TokenCounter): number {
  let total = 0;
  for (const message of messages) {
    total += messageTokens(message, count);
  }
  return total;
}
