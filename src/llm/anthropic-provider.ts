/**
 * Anthropic Provider —— 预留模块（结构与实现要点保留，主体注释）。
 *
 * 为什么暂不实现：同 openai-compatible-provider.ts（确定性优先 / 维护成本 / 密钥费用）。
 * 本文档的重点是**两家协议的差异备忘**——这是「Provider 适配层」教学设计
 * 最好的对照材料：同一份规范形消息，两种协议如何各自表达。
 *
 * == 与 OpenAI 格式的关键差异（适配层必须消化的部分）==
 *
 * 1. system 的位置：
 *    Anthropic 的 system 是**顶层独立参数**，不在 messages 数组里。
 *    适配动作：把规范形 messages[0]（role:'system'）抽出，其余消息保持顺序。
 *
 * 2. 工具调用是 content block，不是消息级字段：
 *    - assistant 消息的 content 是块数组：
 *      [{ type: 'text', text }, { type: 'tool_use', id, name, input: {...} }]
 *      —— input 是**已解析的对象**（OpenAI 的 arguments 是 JSON 字符串，注意差异）；
 *    - 工具结果不是独立 role，而是 user 消息里的 tool_result 块：
 *      [{ type: 'tool_result', tool_use_id, content: '...' }]
 *      （多个结果可合并进同一条 user 消息——这里有一个「消息合并」的适配决策点）。
 *
 * 3. 流式事件名对照（SSE，事件类型多样，非 OpenAI 的单 delta 流）：
 *    - message_start / message_delta / message_stop   → 生命周期（stop_reason、usage）
 *    - content_block_start (type: text | tool_use)    → 文本开始 / tool_call_start
 *    - content_block_delta：
 *        text_delta（text 增量）        → text_delta
 *        input_json_delta（partial_json）→ tool_call_delta
 *        thinking_delta                 → thinking_delta（扩展思考，预留已对齐）
 *    - content_block_stop                             → tool_call_end
 *    注意：content block 用 index 定位；多块可能交错，组装器已按 id 隔离，无需改内核。
 *
 * 4. stop_reason 命名几乎一一对应：end_turn / tool_use / max_tokens /
 *    stop_sequence —— 直接映射，无需翻译层。
 *
 * 5. 错误映射：HTTP 429 → rate_limit_error；529（overloaded）→ provider_error
 *    （可重试）；400 → input_error。
 *
 * 6. 取消：AbortSignal 传给底层 SDK/fetch。
 *
 * == 教学对照点（写《框架对照笔记》时引用）==
 * - 规范形选择「system 在 messages 里」= OpenAI 风格，Anthropic 适配要抽离；
 *   反过来若选 Anthropic 风格，OpenAI 适配要拼回。两边总有一边多一步——
 *   这解释了为什么「适配层」必须存在，以及 API 差异成本无法被框架消灭、只能被集中。
 *
 * == 骨架 ==
 * （取消注释即可开始实现；正文刻意保持无注释，避免块注释嵌套冲突）
 *
 * export class AnthropicProvider implements LLMProvider {
 *   readonly name = 'anthropic';
 *
 *   constructor(private readonly options: { apiKey: string; baseUrl?: string; model: string }) {}
 *
 *   async complete(req: LLMRequest): Promise<LLMResponse> { ... }
 *   async *stream(req: LLMRequest): AsyncIterable<StreamEvent> { ... }
 *   countTokens(text: string): number { ... }
 * }
 */

export {};
