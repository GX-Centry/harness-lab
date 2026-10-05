/**
 * 全局共享类型 —— 全系统的「词汇表」。
 *
 * 设计原则（三条，贯穿全文件）：
 *
 * 1. 「规范形」原则（ADR-003）：
 *    所有 Provider（OpenAI / Anthropic / Fake）的格式差异收敛在 llm/ 适配层，
 *    其余模块只认这里的形状。换模型不改 Harness，这是 Query Engine 层存在的意义。
 *
 * 2. 「形状与构造相邻」：
 *    类型旁边提供工厂函数（userMessage / okResult ...）。各处手写对象字面量
 *    容易写错判别字段（role 与 id 配错、toolCalls 与 toolCallId 张冠李戴），
 *    工厂函数把「正确的形状」封装成唯一入口。
 *
 * 3. 「一切消息不可变」：
 *    数据形状字段全部 readonly；修改 = 构造新对象。
 *    Session 持久化与 checkpoint 恢复的正确性建立在这条约定之上。
 *
 * 依赖方向：types.ts → errors.ts（仅取 ToolErrorCode 类型）。不反向依赖任何模块。
 */

import type { ZodType } from 'zod';
import type { ToolErrorCode } from './errors.ts';

// ===========================================================================
// §1 消息模型（规范形）
// ===========================================================================

/**
 * 工具调用请求（模型发起，Harness 执行）。
 *
 * 字段说明与数据流：
 *   - id：模型生成、工具结果回填时用于配对（toolCallId 必须与它一致）；
 *   - name：工具名，Dispatcher 用它查 Registry；
 *   - args：JSON.parse 之后的参数对象。解析失败时为 undefined——
 *           注意这不是「模型没传参数」，而是「参数 JSON 残缺」（流被截断等），
 *           Dispatcher 会据此产生 input_error 结果让模型自我修正；
 *   - argsRaw：原始 JSON 文本，永远保留。用途：审计、错误上报、调试复现。
 *   - parseError：仅当解析失败时存在，记录失败原因（确定性错误，可测试）。
 */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
  readonly argsRaw: string;
  readonly parseError?: string;
}

/**
 * 规范形消息：四种角色组成判别联合（discriminated union）。
 *
 * 为什么用联合而不是一个宽松的 interface？
 *   - 判别字段 role 让 TS 在每个分支自动收窄字段（如 role:'tool' 时才有 toolCallId），
 *     杂字段在类型层面就不可能表达——「不可能的状态不可表示」；
 *   - Context 压缩、Session 持久化、流式组装都必须对四种角色分别处理，
 *     联合强制穷尽检查（switch 漏 case 直接编译报错）。
 *
 * system 消息约定在数组首位；Anthropic 适配器负责把它抽到独立字段（适配层职责）。
 */
export interface SystemMessage {
  readonly role: 'system';
  readonly content: string;
}

export interface UserMessage {
  readonly role: 'user';
  readonly content: string;
}

export interface AssistantMessage {
  readonly role: 'assistant';
  readonly content: string;
  /** 模型发起的工具调用；无工具调用时省略（而不是空数组，让判断更诚实） */
  readonly toolCalls?: readonly ToolCall[];
}

export interface ToolMessage {
  readonly role: 'tool';
  readonly content: string;
  /** 与发起它的 ToolCall.id 配对——回填正确性是工具循环的命脉 */
  readonly toolCallId: string;
  /** 工具名冗余保存：审计与压缩时不必反查，代价是少量存储 */
  readonly name: string;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

// ---------------------------------------------------------------------------
// 消息工厂函数：正确形状的唯一入口
// ---------------------------------------------------------------------------

export function systemMessage(content: string): SystemMessage {
  return { role: 'system', content };
}

export function userMessage(content: string): UserMessage {
  return { role: 'user', content };
}

/** 构造 assistant 消息；toolCalls 缺省时省略字段（保持「无调用」的诚实表达） */
export function assistantMessage(content: string, toolCalls?: readonly ToolCall[]): AssistantMessage {
  return toolCalls === undefined ? { role: 'assistant', content } : { role: 'assistant', content, toolCalls };
}

/** 构造工具结果消息；toolCallId 与 name 必须来自发起调用，工厂不做校验（Dispatcher 保证配对） */
export function toolMessage(toolCallId: string, name: string, content: string): ToolMessage {
  return { role: 'tool', content, toolCallId, name };
}

// ===========================================================================
// §2 流式事件（Provider → StreamAssembler 的协议）
// ===========================================================================

/** 停止原因：Loop 依此判断「自然结束 / 还要执行工具 / 被截断」 */
export type StopReason =
  | 'end_turn' // 模型自然说完
  | 'tool_use' // 模型要调用工具（Loop 继续）
  | 'max_tokens' // 输出被长度截断（可能需要提示模型"继续说"或压缩重试）
  | 'stop_sequence' // 命中停止序列
  | 'aborted' // 被取消（用户中断 / 超时）
  | 'error'; // 流中途出错（组装器收尾时使用）

/**
 * Loop 级终止原因 —— 「整个 query 为什么结束」（与 LLM 层 StopReason 是两个维度）。
 *
 * 为什么必须独立于 StopReason？
 *   一次 query 可能经历 N 次模型调用，每次都有各自的 StopReason；
 *   但「这次 query 最终为什么终止」只有一个答案，且包含 LLM 层不存在的状态
 *   （max_turns 是框架的硬约束，不是模型的行为）。混用会导致「轮次熔断被
 *   误报为某种模型行为」这类语义污染。
 *
 * 映射关系（agent-loop 在 query_end 事件中报告）：
 *   completed ← 模型不再调用工具（自然结束）
 *   max_turns ← 达到 loop.maxTurns（防死循环的硬约束）
 *   aborted   ← 用户取消 / 全局超时（控制流）
 *   error     ← 致命异常向上抛；此值仅用于 finally 里 query_end 事件的记账
 */
export type LoopStopReason = 'completed' | 'max_turns' | 'aborted' | 'error';

/** token 用量：预算检查与成本统计的原始数据 */
export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * 流式事件联合（ADR-008）。
 *
 * 为什么是 Union 而不是宽对象？StreamAssembler 是显式状态机，
 * Union 让状态迁移可以穷尽检查——「半个 JSON 去 parse」这类经典 bug
 * 在类型层面就被排除（tool_call 必须等 tool_call_end 才能整体 parse）。
 *
 * 生命周期（合法顺序）：
 *   (text_delta | thinking_delta | tool_call_start/delta/end)* → message_end
 *   tool_call 序列：start(id) → delta(id)* → end(id)，不同 id 之间不得交错。
 */
export type StreamEvent =
  | { type: 'text_delta'; text: string } // 即到即显：可直接投给 UI
  | { type: 'thinking_delta'; text: string } // 预留：推理模型的思考流（不注入对话历史）
  | { type: 'tool_call_start'; id: string; name: string } // 新的工具调用开始
  | { type: 'tool_call_delta'; id: string; argsDelta: string } // 参数 JSON 分片
  | { type: 'tool_call_end'; id: string } // 该调用参数完整，组装器可整体 parse
  | { type: 'message_end'; stopReason: StopReason; usage: Usage }; // 本轮流结束（必定收尾）

// ===========================================================================
// §3 Provider 协议（Query Engine 的边界）
// ===========================================================================

/**
 * 传给模型的工具声明。注意与 §5 Tool 的区别：
 *   - ToolSpec.inputSchema 是 JSON Schema（线路上的格式，给模型看的）；
 *   - Tool.inputSchema 是 zod（进程内的校验器，给运行时用的）。
 * 两者的转换发生在 tools/ 层（zod v4 内置 z.toJSONSchema()）。
 */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

/**
 * JSON Schema 的简化表示。
 * 教学取舍：完整类型（json-schema-to-ts 等）编译期成本高、收益低，
 * 这里用宽松的 Record；真实校验由 zod 在运行时完成。
 */
export type JsonSchema = Record<string, unknown>;

/**
 * 一次模型调用的完整请求。
 * 注意：system 消息作为 messages 数组首元素传递（规范形约定），
 * 不单独开 system 字段——Anthropic 适配器负责抽离，保持规范形单轨。
 */
export interface LLMRequest {
  readonly model: string;
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolSpec[];
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  /** 协作式取消：用户中断 / 超时都会触发；Provider 必须传递给它底层的 http 客户端 */
  readonly signal?: AbortSignal;
}

/** 一次模型调用的完整结果（complete 路径；stream 路径由组装器产出同样的形状） */
export interface LLMResponse {
  /** complete 的产物必定是 assistant 消息——类型收窄即文档 */
  readonly message: AssistantMessage;
  readonly stopReason: StopReason;
  readonly usage: Usage;
}

/**
 * Provider 抽象：唯一允许「接触外部网络」的边界。
 * 其余所有模块（Loop / Context / Dispatcher）只依赖这个接口——
 * 换上 FakeProvider 就能在离线、确定性的环境里跑通全部测试（铁律 2）。
 */
export interface LLMProvider {
  readonly name: string;
  /** 非流式调用：简单场景与对照实验用（测试里更易断言） */
  complete(req: LLMRequest): Promise<LLMResponse>;
  /** 流式调用：生产路径；事件序列见 StreamEvent 注释 */
  stream(req: LLMRequest): AsyncIterable<StreamEvent>;
  /**
   * token 计数：上下文预算是硬约束（ADR-007），计数必须可预估。
   * Fake 用近似公式（如 字符数/4），真实 Provider 接官方 tokenizer。
   * 注意：只估算文本；消息结构开销（role、格式符）由预算层加固定余量补偿。
   */
  countTokens(text: string): number;
}

// ===========================================================================
// §4 风险与权限（Permission 层的输入语言）
// ===========================================================================

/**
 * 工具风险分级：由工具作者声明，被 Permission 规则消费。
 * 语义边界（教学简化但足够真实）：
 *   low      纯计算、只读且无副作用（如 calculator、echo）
 *   medium   读取本地资源（如 fs-read）、只读网络查询
 *   high     写操作、执行命令、产生外部副作用（如 fs-write、shell）
 *   critical 不可逆或高代价操作（删除、转账、发布）——默认必须人工确认
 */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/** 权限决策三态（ADR-005：deny 是「对话的一部分」，不是崩溃） */
export type PermissionDecision =
  | 'allow' // 放行
  | 'confirm' // 待人工确认（CLI 交互；未来 Web 形态下是异步等待——所以必须抽象）
  | 'deny'; // 拒绝：生成 permission_denied 工具结果返回给模型

// ===========================================================================
// §5 Tool 协议（工具作者的唯一契约）
// ===========================================================================

/**
 * 工具结果：判别联合，ok 字段决定 error 字段是否存在。
 * 「永不抛异常」（ADR-004）：错误即数据——模型需要看到失败原因才能自我修正。
 * meta 不注入模型上下文，仅供 hook / 可观测层消费（如计时、命中的缓存等）。
 */
export type ToolResult =
  | { readonly ok: true; readonly content: string; readonly meta?: Readonly<Record<string, unknown>> }
  | {
      readonly ok: false;
      readonly content: string; // 给模型看的失败说明（应包含修正提示）
      readonly error: { readonly code: ToolErrorCode; readonly message: string };
      readonly meta?: Readonly<Record<string, unknown>>;
    };

/** 成功结果工厂 */
export function okResult(content: string, meta?: Readonly<Record<string, unknown>>): ToolResult {
  return meta === undefined ? { ok: true, content } : { ok: true, content, meta };
}

/**
 * 失败结果工厂。
 * content 与 error.message 的分工：content 是「给模型读的」自然语言建议，
 * error.message 是「给日志读的」精确描述——两者刻意分开。
 */
export function failedResult(code: ToolErrorCode, message: string, content?: string): ToolResult {
  return { ok: false, content: content ?? message, error: { code, message } };
}

/**
 * 工具执行上下文：框架注入给工具的「外部世界接口」。
 *
 * 每个字段的存在理由：
 *   - sessionId / queryId：审计与事件关联（哪个会话的哪一问触发了这次执行）；
 *   - workingDir：文件类工具的安全边界（相对路径一律解析到这里，不是 cwd）；
 *   - signal：协作式取消。用户中断 / 全局超时会 abort，工具应尽快返回
 *     （长跑工具要定期检查 signal.aborted，而不是无视它）；
 *   - timeoutMs：框架层单工具超时（Dispatcher 用 Promise.race 兜底）。
 */
export interface ToolContext {
  readonly sessionId: string;
  readonly queryId: string;
  readonly workingDir: string;
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
}

/**
 * Tool 接口：工具作者实现这五个成员即可被整个 Harness 驱动。
 *
 * 泛型说明：TInput 由 inputSchema（zod）推导。执行管线上的校验顺序是：
 *   模型给的 args（unknown）→ zod safeParse → 通过后才是 TInput → execute()。
 * 也就是说 execute 里可以安全假设输入已通过校验（这是协议承诺）。
 */
export interface Tool<TInput = unknown> {
  readonly name: string;
  readonly description: string;
  /** schema 一物三用：运行前校验、转换成模型可见的 ToolSpec、测试夹具 */
  readonly inputSchema: ZodType<TInput>;
  readonly risk: RiskLevel;
  /**
   * 单次执行的超时预算（毫秒）。缺省时 Dispatcher 用全局默认值
   * （config.tools.defaultTimeoutMs）。
   *
   * 为什么需要「工具自声明」？（w13 引入——子代理工具的第一个消费者）
   *   全局默认值是「普通工具」的合理猜测；但子代理工具内部有自己的
   *   协作式超时（taskTimeoutMs），外层 Dispatcher 的保护性超时必须
   *   **晚于**内部超时触发——否则外层先熔断，子循环被丢下成为僵尸。
   *   声明权交给工具作者（谁最清楚自己该跑多久），Dispatcher 只做仲裁。
   */
  readonly timeoutMs?: number;
  /**
   * 执行工具。协议约定：
   *   - 永不 throw（失败用 failedResult 表达，框架仍会兜底 catch）；
   *   - 尊重 ctx.signal（取消时尽快返回）；
   *   - 返回的 content 是模型唯一能看到的内容（应简洁、自包含）。
   */
  execute(input: TInput, ctx: ToolContext): Promise<ToolResult>;
}

/**
 * 异构工具集合的元素类型。
 *
 * 为什么这里允许 any？Registry 要存放 inputSchema 各异的工具（泛型不同），
 * 而 zod 的 ZodType<T> 因 Input 位置逆变、Output 位置协变，
 * 无法把 Tool<{a:number}> 安全赋给 Tool<unknown>（TS 会正确报错）。
 * 这是「异构容器 + 泛型元素」的经典取舍点：
 *   类型在注册时校验（register 泛型签名），容器内部用 any，
 *   执行边界（Dispatcher）把 args 当 unknown 处理并重新校验——
 *   安全性由运行时 zod 兜住，不靠这里的静态类型。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = Tool<any>;

// ===========================================================================
// §6 Hook 协议（横切关注点的插槽语言）
// ===========================================================================

/**
 * 管道插槽时刻（Hook 能挂到哪些点）。
 * 与 Dispatcher 四步链、Loop 的关系：
 *   tool_call_before  → pre-hooks（参数脱敏、权限预检等）
 *   tool_call_after   → post-hooks（审计、结果压缩、记忆触发等）
 *   message_before_llm→ 上下文组装完成后、调用模型前（最后防线：脱敏/限流）
 *   query_start/end   → 一次 query 的生命周期边界（指标、初始化）
 *   session_save      → 持久化前（数据落盘的最后加工点）
 */
export type HookEventName =
  | 'tool_call_before'
  | 'tool_call_after'
  | 'message_before_llm'
  | 'query_start'
  | 'query_end'
  | 'session_save';

/**
 * Hook 输出：5 种结果构成管道的「灵魂」（ADR-009）。
 * 它决定了「横切逻辑能在不改主流程的前提下做多少事」：
 *   continue      → 什么都不做，下一个 hook
 *   modify_input  → 替换参数后继续（后续 hook 看到的是新参数；权限检查也基于新参数）
 *   modify_result → 替换结果后继续（仅 tool_call_after 阶段有 result 可改）
 *   block         → 阻断本次调用，reason 会转成给模型的失败结果
 *   skip          → 当前调用判定已定（如已 block），跳过后续 hook
 */
export type HookOutcome =
  | { kind: 'continue' }
  | { kind: 'modify_input'; input: unknown }
  | { kind: 'modify_result'; result: ToolResult }
  | { kind: 'block'; reason: string }
  | { kind: 'skip' };

/** Hook 输出的 kind 字面量联合（事件上报用，避免上报时携带大对象） */
export type HookOutcomeKind = HookOutcome['kind'];

/**
 * 管道载荷：按事件类型填充的「公共信封 + 可选字段」。
 *
 * 设计取舍：不为每个事件名做独立的判别联合（那需要给 payload 也加 type 判别字段，
 * 且 Hook 作者要频繁做类型收窄——教学成本高）。这里用宽松但文档清晰的可选字段：
 * 每个 hook 通过 events 声明自己关心的事件，handler 里按 ctx 约定取用。
 * 若未来需要强约束，升级路径是：把 HookPayload 改为判别联合 + 泛型 Handler。
 */
export interface HookPayload {
  readonly event: HookEventName;
  readonly sessionId: string;
  readonly queryId?: string;
  /** tool_call_before / after 阶段存在 */
  readonly toolCall?: ToolCall;
  /** 工具元信息（风险级照抄 Registry 声明），供权限与审计 hook 使用 */
  readonly tool?: { readonly name: string; readonly risk: RiskLevel };
  /** tool_call_before 阶段：即将执行的参数（可被 modify_input 替换） */
  readonly input?: unknown;
  /** tool_call_after 阶段：工具结果（可被 modify_result 替换） */
  readonly result?: ToolResult;
  /** message_before_llm 阶段：即将发送的消息数组 */
  readonly messages?: readonly Message[];
}

/** Hook 运行时环境：只给「读环境」的能力，不给「改世界」的能力（强制走 outcome） */
export interface HookContext {
  readonly sessionId: string;
  readonly queryId: string;
  /** 注入时钟（确定性测试铁律）：hook 里不许直接 new Date() */
  readonly now: () => number;
  /** 简易日志通道：进入事件流（hook_error 之外的信息用日志表达） */
  readonly log: (message: string) => void;
}

/**
 * Hook 接口。
 *   - priority：数字小者先执行（同优先级按注册顺序，稳定排序由管道保证）；
 *   - events：声明关心的事件名集合（管道据此路由，避免每个 hook 都收全量事件）；
 *   - handler：返回 HookOutcome；**抛异常不阻断主流程**（ADR-009），
 *     管道会捕获并上报 hook_error 事件。
 */
export interface Hook {
  readonly name: string;
  readonly priority: number;
  readonly events: readonly HookEventName[];
  handler(payload: HookPayload, ctx: HookContext): Promise<HookOutcome>;
}

// ===========================================================================
// §7 会话状态（Session 状态机的状态集）
// ===========================================================================

/**
 * 会话状态机（记录「最近一次 query 的结局」——不是会话的生死判决）：
 *   created → processing → completed   （query 正常完成；同一会话可再次 processing 继续多轮对话）
 *                        ↘ failed      （不可恢复的失败：如 provider 持续不可用；下次提问即重试）
 *                        ↘ interrupted （可恢复的中断：用户 Ctrl+C / 进程被杀）
 *
 * 「恢复」的含义（w10 实现，修订了 w04 初版的表述）：
 *   恢复专指 checkpoint 路径——只对 interrupted（以及崩溃残留的 processing）
 *   有意义：从最近检查点补齐中断的调用占位，再继续。completed / failed
 *   无需恢复（消息已完整落盘），直接以新 query 继续即可。
 *   初版注释写「completed / failed 是终态，只能新建会话」，把「query 终态」
 *   误说成了「会话终态」——多轮 REPL 形态下每轮新建会话并不成立。
 */
export type SessionState = 'created' | 'processing' | 'completed' | 'failed' | 'interrupted';
