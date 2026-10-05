/**
 * OpenAI 兼容 Provider（已解冻）—— 真实模型接入的完整适配层。
 *
 * == 解冻记录（对应本文件此前预留注释的「解冻条件」）==
 * 条件命中：「需要真实模型端到端演示」。实现遵循此前备忘的六个要点，
 * 并在两个地方做了超出备忘的防御（都来自真实协议的踩坑）：
 *   - tool_calls 的 id/name 迟到：按 delta.index 记账，等 id+name 齐才发
 *     tool_call_start（此前攒下的 arguments 分片在 start 时补发）；
 *   - 空响应防御：若整条流没有出现任何合法 chunk（例如 baseUrl 填成了
 *     一个 HTML 页面），收尾时抛 provider_error 而不是「空回复」。
 *
 * == 协议要点（规范形 → OpenAI Chat Completions）==
 *   1. 消息映射：system 原样在 messages[0]（规范形约定）；assistant.toolCalls
 *      → tool_calls（arguments 是 JSON **字符串**，原样透传 argsRaw）；
 *      tool 消息 → { role:'tool', tool_call_id, content }。
 *   2. 工具声明：ToolSpec → { type:'function', function:{ name, description,
 *      parameters: inputSchema } }。
 *   3. 流式解析：SSE 逐行 "data: {json}"，终止行 "data: [DONE]"；
 *      delta.content → text_delta；delta.reasoning_content（DeepSeek 扩展）
 *      → thinking_delta（组装器当前丢弃，形状先对齐）；finish_reason 映射：
 *      stop→end_turn / tool_calls→tool_use / length→max_tokens；
 *      usage 需要 stream_options.include_usage（末块出现）——部分兼容服务
 *      不返回 usage，因此有「近似估算兜底」；真实服务中间分片普遍携带
 *      "usage":null（DeepSeek 流式行为）——null 与缺失同义，不得误入捕获分支。
 *   4. 错误映射：400/401/403/404 → input_error（不可重试——改配置再试）；
 *      408 → timeout_error；429 → rate_limit_error；5xx → provider_error。
 *   5. 取消：AbortSignal 直传 fetch；内部用 AbortSignal.any 合成超时信号，
 *      超时与用户取消在 catch 里按「哪个信号触发」区分（用户取消抛
 *      AbortError——取消是控制流不是故障，与错误体系约定一致）。
 *   6. countTokens：共享近似公式（token-estimate.ts）。
 *
 * == 模型路由约定 ==
 * 请求用哪个模型名由 **req.model** 决定（= config.llm.defaultModel，
 * 见 config.ts 的注释：Fake 忽略、真实 Provider 用它做默认路由）。
 * 因此构造选项里没有 model——装配层通过 defineConfig 覆盖 defaultModel。
 *
 * == 预设表（OPENAI_COMPATIBLE_PRESETS）==
 * 开源生态常见 OpenAI 兼容服务的 Base URL / 推荐模型清单——网页设置
 * 面板「自由选择服务商」的数据源，也是「自定义 URL」时的对照参考。
 * Base URL 语义：后接 /chat/completions 与 /models；多数服务以 /v1 结尾，
 * 少数（如智谱 v4）路径不同——不做智能补全，用户给什么拼什么，
 * 配置错误的引导交给错误消息（404 → 提示检查 baseUrl）。
 *
 * 依赖方向：llm/openai-compatible-provider.ts → stream-assembler /
 * token-estimate / retry(无) / types / errors。只依赖全局 fetch（Node 内建）。
 */

import { HarnessError } from '../errors.ts';
import type { LLMRequest, LLMResponse, LLMProvider, Message, StopReason, StreamEvent, ToolSpec, Usage } from '../types.ts';
import { assembleStream } from './stream-assembler.ts';
import { estimateTokens } from './token-estimate.ts';

// ===========================================================================
// §1 选项与预设
// ===========================================================================

export interface OpenAICompatibleOptions {
  /** API 密钥；空字符串 = 不发送 Authorization 头（本地 llama.cpp / Ollama 等无鉴权服务） */
  readonly apiKey: string;
  /** OpenAI 兼容端点前缀（如 https://api.deepseek.com/v1）；缺省 DeepSeek */
  readonly baseUrl?: string;
  /** 单次请求超时（毫秒，含流式全过程）；缺省 120_000（大模型慢，放宽于 config 默认） */
  readonly timeoutMs?: number;
}

/** 预设服务商（网页设置面板的「自由选择」数据源） */
export interface ProviderPreset {
  readonly id: string;
  readonly label: string;
  /** 端点前缀（'' = 自定义，不预填） */
  readonly baseUrl: string;
  /** 推荐模型名（'' = 需用户填写，如本地服务以 /models 列表为准） */
  readonly model: string;
  /** 是否需要 API key（本地服务 false） */
  readonly needsKey: boolean;
  /** UI 提示（可选） */
  readonly hint?: string;
}

/** 缺省端点与模型（DeepSeek——缺省服务商的决策见 real-provider.ts） */
export const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
export const DEFAULT_MODEL = 'deepseek-chat';

export const OPENAI_COMPATIBLE_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    needsKey: true,
    hint: 'deepseek-reasoner 为推理模型（思考流走 thinking_delta）',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    needsKey: true,
  },
  {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V3',
    needsKey: true,
  },
  {
    id: 'moonshot',
    label: 'Moonshot（Kimi）',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2-0905-preview',
    needsKey: true,
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    needsKey: true,
    hint: '注意：路径是 /api/paas/v4，不是 /v1',
  },
  {
    id: 'dashscope',
    label: '通义千问（DashScope）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    needsKey: true,
  },
  {
    id: 'ollama',
    label: 'Ollama（本地）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen3:8b',
    needsKey: false,
    hint: '本地服务无需 key；模型名以 ollama list 为准',
  },
  {
    id: 'llamacpp',
    label: 'llama.cpp（本地）',
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: '',
    needsKey: false,
    hint: 'llama-server 默认端口；模型名以 /v1/models 列表为准',
  },
  {
    id: 'custom',
    label: '自定义（任意 OpenAI 兼容服务）',
    baseUrl: '',
    model: '',
    needsKey: true,
    hint: '任何兼容 /chat/completions 的服务都可接入——包括 one-api 等聚合网关',
  },
];

// ===========================================================================
// §2 线路格式（OpenAI Chat Completions 的窄类型——只描述我们用到的字段）
// ===========================================================================

/** SSE 一个 chunk 的形状（字段全部可缺省：心跳块、末块、各家实现有差异） */
interface ChatChunk {
  readonly choices?: ReadonlyArray<{
    readonly delta?: {
      readonly content?: string | null;
      /** DeepSeek 扩展：推理模型的思考流 */
      readonly reasoning_content?: string | null;
      readonly tool_calls?: ReadonlyArray<{
        /** 权威排序键（id/name 可能延迟出现，index 先到） */
        readonly index?: number;
        readonly id?: string;
        readonly function?: { readonly name?: string; readonly arguments?: string };
      }>;
    };
    readonly finish_reason?: string | null;
  }>;
  /** 末块携带；真实服务的中间分片为 "usage":null（DeepSeek 行为）——需容 null */
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number } | null;
}

// ===========================================================================
// §3 Provider 实现
// ===========================================================================

/** 单个工具调用的组装缓冲（按 delta.index 记账） */
interface OpenSlice {
  id: string;
  name: string;
  started: boolean;
  ended: boolean;
  /** start 之前攒下的参数分片（id/name 迟到时的防御） */
  pendingArgs: string[];
}

/** 流解析的共享状态 */
interface StreamState {
  readonly slices: Map<number, OpenSlice>;
  /** 全部 argsDelta 的累积（usage 兜底估算用） */
  readonly argsTotal: string[];
  readonly textChunks: string[];
  stopReason: StopReason | undefined;
  usage: Usage | undefined;
  /** 是否见过任何合法 chunk（空响应防御的判据） */
  sawChunk: boolean;
  done: boolean;
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name = 'openai-compatible';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: OpenAICompatibleOptions) {
    this.apiKey = options.apiKey.trim();
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  /** 端点前缀（只读快照——UI 展示与诊断用） */
  get endpoint(): string {
    return this.baseUrl;
  }

  /**
   * 非流式调用 = 内部跑一遍完整流再组装（与 FakeProvider 同一策略：
   * 两条路径行为严格一致，断言只需写一份语义）。
   */
  async complete(req: LLMRequest): Promise<LLMResponse> {
    const result = await assembleStream(this.stream(req));
    return { message: result.message, stopReason: result.stopReason, usage: result.usage };
  }

  /** token 近似计数：共享公式（真实精度需要官方 tokenizer——见 token-estimate.ts） */
  countTokens(text: string): number {
    return estimateTokens(text);
  }

  /** 拉取可用模型列表（连通测试的「免费」路径：GET /models，多数兼容服务都实现） */
  async listModels(): Promise<readonly string[]> {
    const response = await this.request('models', { method: 'GET' });
    const data = (await response.json()) as { data?: ReadonlyArray<{ id?: unknown }> };
    return (data.data ?? [])
      .map((m) => (typeof m.id === 'string' ? m.id : ''))
      .filter((id) => id !== '');
  }

  /**
   * 流式调用：SSE 全流程（建立连接 → 逐行翻译 → 收尾）。
   * 收尾三件事：空响应防御（没见到任何合法 chunk → provider_error）、
   * 补发未闭合的 tool_call_end（按 index 升序）、产出 message_end。
   */
  async *stream(req: LLMRequest): AsyncIterable<StreamEvent> {
    const response = await this.postChat(req);
    if (response.body === null) {
      throw new HarnessError('provider_error', '响应没有 body（流式连接建立失败）', {
        where: 'llm/openai-compatible',
      });
    }

    const state: StreamState = {
      slices: new Map(),
      argsTotal: [],
      textChunks: [],
      stopReason: undefined,
      usage: undefined,
      sawChunk: false,
      done: false,
    };

    const decoder = new TextDecoder('utf-8');
    const reader = response.body.getReader();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // 流式解码：UTF-8 多字节字符跨网络分块边界不被切坏（中文场景关键）
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          yield* this.translateLine(line, state);
          if (state.done) break;
          newline = buffer.indexOf('\n');
        }
        if (state.done) {
          await reader.cancel().catch(() => undefined); // [DONE] 后释放连接（静默）
          break;
        }
      }
      // 收尾：flush 解码器 + 处理无换行结尾的残留行
      if (!state.done) {
        buffer += decoder.decode();
        if (buffer !== '') yield* this.translateLine(buffer.replace(/\r$/, ''), state);
      }
    } finally {
      reader.releaseLock();
    }

    // 空响应防御：HTTP 200 但没有一个合法 chunk（如 baseUrl 指向 HTML 页面）
    if (!state.sawChunk) {
      throw new HarnessError(
        'provider_error',
        `响应中没有有效的流式数据块——确认 ${this.baseUrl} 指向 OpenAI 兼容端点（/chat/completions）`,
        { where: 'llm/openai-compatible' },
      );
    }

    // 补发未闭合的工具调用 end（按 index 升序——与到达顺序一致）
    let anyCall = false;
    for (const [, slice] of [...state.slices.entries()].sort((a, b) => a[0] - b[0])) {
      if (slice.started && !slice.ended) {
        slice.ended = true;
        anyCall = true;
        yield { type: 'tool_call_end', id: slice.id };
      }
    }

    // message_end：stopReason 缺省推导与 FakeProvider 一致；usage 有兜底估算
    const stopReason = state.stopReason ?? (anyCall ? 'tool_use' : 'end_turn');
    const usage = state.usage ?? this.deriveUsage(req, state);
    yield { type: 'message_end', stopReason, usage };
  }

  // -------------------------------------------------------------------------
  // 私有实现
  // -------------------------------------------------------------------------

  /**
   * 一行 SSE → 若干 StreamEvent。
   * 非 data 行（event: / 注释 / 空行）静默跳过；坏 JSON 行也跳过——
   * 不在这里报错，由收尾的「空响应防御」统一判定（坏行可能只是
   * 网关插入的日志行，而「一行合法 chunk 都没有」才是真正的问题信号）。
   */
  private *translateLine(line: string, state: StreamState): Generator<StreamEvent> {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (payload === '') return;
    if (payload === '[DONE]') {
      state.done = true;
      return;
    }
    let chunk: ChatChunk;
    try {
      chunk = JSON.parse(payload) as ChatChunk;
    } catch {
      return;
    }
    // null 归一："usage":null 是真实服务的常态（DeepSeek 每个中间分片都带）
    // ——按「没有 usage」处理，绝不能进入下面的捕获分支
    const usage = chunk.usage ?? undefined;
    // 结构判定：合法 chunk 必含 choices（数组）或 usage（非 null 对象）——
    // 这是区分「真 chunk」与「200 状态下的 JSON 错误体」的判据
    if (!Array.isArray(chunk.choices) && usage === undefined) return;
    state.sawChunk = true;

    if (usage !== undefined) {
      state.usage = {
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
      };
    }

    const choice = chunk.choices?.[0];
    if (choice === undefined) return;

    const delta = choice.delta;
    if (delta !== undefined) {
      // 思考流（DeepSeek reasoner 扩展）：规范形已有 thinking_delta，形状对齐
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
        yield { type: 'thinking_delta', text: delta.reasoning_content };
      }
      if (typeof delta.content === 'string' && delta.content !== '') {
        state.textChunks.push(delta.content);
        yield { type: 'text_delta', text: delta.content };
      }
      for (const tc of delta.tool_calls ?? []) {
        yield* this.translateToolCallDelta(tc, state);
      }
    }
    if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') {
      state.stopReason = mapFinishReason(choice.finish_reason);
    }
  }

  /**
   * tool_calls 增量翻译：delta.index 是权威排序键（id/name 可能迟到）。
   * 开闸条件：id 与 name 同时齐全 → tool_call_start + 补发攒下的参数分片。
   */
  private *translateToolCallDelta(
    tc: {
      readonly index?: number;
      readonly id?: string;
      readonly function?: { readonly name?: string; readonly arguments?: string };
    },
    state: StreamState,
  ): Generator<StreamEvent> {
    const index = typeof tc.index === 'number' ? tc.index : 0;
    let slice = state.slices.get(index);
    if (slice === undefined) {
      slice = { id: '', name: '', started: false, ended: false, pendingArgs: [] };
      state.slices.set(index, slice);
    }
    if (typeof tc.id === 'string' && tc.id !== '') slice.id = tc.id;
    if (typeof tc.function?.name === 'string' && tc.function.name !== '') slice.name = tc.function.name;

    if (!slice.started && slice.id !== '' && slice.name !== '') {
      slice.started = true;
      yield { type: 'tool_call_start', id: slice.id, name: slice.name };
      for (const pending of slice.pendingArgs) {
        yield { type: 'tool_call_delta', id: slice.id, argsDelta: pending };
      }
      slice.pendingArgs.length = 0;
    }

    const argsDelta = typeof tc.function?.arguments === 'string' ? tc.function.arguments : '';
    if (argsDelta !== '') {
      state.argsTotal.push(argsDelta);
      if (slice.started) yield { type: 'tool_call_delta', id: slice.id, argsDelta };
      else slice.pendingArgs.push(argsDelta);
    }
  }

  /** usage 兜底：兼容服务不返回 usage 时的近似估算（输入=消息+工具声明，输出=文本+参数 JSON） */
  private deriveUsage(req: LLMRequest, state: StreamState): Usage {
    const inputParts: string[] = [];
    for (const m of req.messages) inputParts.push(m.content);
    for (const spec of req.tools ?? []) {
      inputParts.push(`${spec.name} ${spec.description} ${JSON.stringify(spec.inputSchema)}`);
    }
    return {
      inputTokens: estimateTokens(inputParts.join('\n')),
      outputTokens: estimateTokens(state.textChunks.join('') + state.argsTotal.join('')),
    };
  }

  /** 组装并发送 Chat Completions 流式请求 */
  private async postChat(req: LLMRequest): Promise<Response> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: toOpenAIMessages(req.messages),
      stream: true,
      // usage 默认不在流里；请求末块携带（不支持的兼容服务会忽略它）
      stream_options: { include_usage: true },
    };
    if (req.tools !== undefined && req.tools.length > 0) body['tools'] = toOpenAITools(req.tools);
    if (req.maxOutputTokens !== undefined) body['max_tokens'] = req.maxOutputTokens;
    if (req.temperature !== undefined) body['temperature'] = req.temperature;
    return this.request('chat/completions', {
      method: 'POST',
      body: JSON.stringify(body),
      signal: req.signal,
    });
  }

  /**
   * 统一请求入口：URL 拼接 / 鉴权头 / 超时合成 / 网络错误映射。
   * 超时与用户取消的区分看「哪个信号先触发」：用户取消抛 AbortError
   * （取消是控制流不是故障——与错误体系约定一致，上层据此静默收尾）；
   * 超时抛 timeout_error（可重试）。
   */
  private async request(
    path: string,
    init: { readonly method: string; readonly body?: string; readonly signal?: AbortSignal },
  ): Promise<Response> {
    const url = `${this.baseUrl}/${path}`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    // 空 key = 无鉴权服务（本地 llama.cpp / Ollama）：不发 Authorization 头
    if (this.apiKey !== '') headers['Authorization'] = `Bearer ${this.apiKey}`;

    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = init.signal === undefined ? timeoutSignal : AbortSignal.any([init.signal, timeoutSignal]);

    let response: Response;
    try {
      response = await fetch(url, {
        method: init.method,
        headers,
        ...(init.body === undefined ? {} : { body: init.body }),
        signal,
      });
    } catch (raw) {
      if (init.signal?.aborted === true) {
        throw new DOMException('LLM 请求被用户取消', 'AbortError');
      }
      if (timeoutSignal.aborted) {
        throw new HarnessError('timeout_error', `请求超时（${this.timeoutMs}ms）：${url}`, {
          where: 'llm/openai-compatible',
          cause: raw,
        });
      }
      throw new HarnessError('provider_error', `网络请求失败：${toMessage(raw)}`, {
        where: 'llm/openai-compatible',
        cause: raw,
      });
    }
    if (!response.ok) {
      throw await mapHttpError(response, this.baseUrl);
    }
    return response;
  }

}

// ===========================================================================
// §4 映射纯函数（无状态，可单测）
// ===========================================================================

/** Base URL 规范化：去尾斜杠；误填完整端点时回退到前缀 */
function normalizeBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, '');
  const suffix = '/chat/completions';
  if (url.endsWith(suffix)) url = url.slice(0, -suffix.length);
  return url === '' ? DEFAULT_BASE_URL : url;
}

/**
 * 规范形消息 → OpenAI 消息数组。
 * 两个忠实性细节：
 *   - assistant 带工具调用且正文为空 → content: null（部分服务严格要求非空串）；
 *   - 工具参数原样透传 argsRaw（不重序列化 args——残缺 JSON 也要让模型看到原貌，
 *     与「错误即数据」同一精神）。
 */
function toOpenAIMessages(messages: readonly Message[]): unknown[] {
  return messages.map((m) => {
    switch (m.role) {
      case 'system':
        return { role: 'system', content: m.content };
      case 'user':
        return { role: 'user', content: m.content };
      case 'assistant': {
        const calls = m.toolCalls ?? [];
        if (calls.length === 0) return { role: 'assistant', content: m.content };
        return {
          role: 'assistant',
          content: m.content === '' ? null : m.content,
          tool_calls: calls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.argsRaw === '' ? '{}' : tc.argsRaw },
          })),
        };
      }
      case 'tool':
        return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
      default: {
        // 穷尽检查惯用法（与 stream-assembler 同款）
        const unhandled: never = m;
        throw new HarnessError('internal_error', `未知消息角色: ${JSON.stringify(unhandled)}`, {
          where: 'llm/openai-compatible',
        });
      }
    }
  });
}

/** 工具声明 → OpenAI tools 数组 */
function toOpenAITools(tools: readonly ToolSpec[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

/** finish_reason → StopReason（未知值宽容映射为 end_turn——不因新枚举炸协议） */
function mapFinishReason(reason: string): StopReason {
  switch (reason) {
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'stop':
    default:
      return 'end_turn';
  }
}

/** HTTP 错误 → HarnessError（错误码语义见文件头第 4 点） */
async function mapHttpError(response: Response, baseUrl: string): Promise<HarnessError> {
  const status = response.status;
  const detail = await readErrorDetail(response);
  const suffix = detail === '' ? '' : `——${detail}`;
  const where = 'llm/openai-compatible';
  if (status === 400) {
    return new HarnessError('input_error', `请求被拒绝（HTTP 400：模型名或参数不合法）${suffix}`, { where });
  }
  if (status === 401 || status === 403) {
    return new HarnessError('input_error', `认证失败（HTTP ${status}）——检查 API key${suffix}`, { where });
  }
  if (status === 404) {
    return new HarnessError('input_error', `端点不存在（HTTP 404）——检查 baseUrl（当前 ${baseUrl}，通常以 /v1 结尾）${suffix}`, { where });
  }
  if (status === 408) {
    return new HarnessError('timeout_error', `服务端超时（HTTP 408）${suffix}`, { where });
  }
  if (status === 429) {
    return new HarnessError('rate_limit_error', `被限流（HTTP 429）——降低频率或稍后重试${suffix}`, { where });
  }
  if (status >= 500) {
    return new HarnessError('provider_error', `模型服务错误（HTTP ${status}）${suffix}`, { where });
  }
  return new HarnessError('provider_error', `意外的 HTTP ${status}${suffix}`, { where });
}

/** 读取错误详情：优先 JSON 的 error.message（OpenAI 风格），退回纯文本截断 */
async function readErrorDetail(response: Response): Promise<string> {
  let text = '';
  try {
    text = await response.text();
  } catch {
    return '';
  }
  if (text.trim() === '') return '';
  try {
    const data = JSON.parse(text) as { error?: { message?: unknown }; message?: unknown };
    const message = data.error?.message ?? data.message;
    if (typeof message === 'string' && message !== '') return message.slice(0, 300);
  } catch {
    // 非 JSON：当纯文本用
  }
  return text.slice(0, 300);
}

/** 任意抛出物 → 可读消息（网络层错误归类用） */
function toMessage(raw: unknown): string {
  return raw instanceof Error ? raw.message : String(raw);
}
