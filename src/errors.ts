/**
 * 错误分类体系 —— 全系统的「错误语言」。
 *
 * 为什么错误要单独一个文件、先于一切模块定型？
 *   1. 错误是跨模块的公共语言：内核 / 工具 / Provider / 权限 / 存储都要表达失败，
 *      如果不先统一，每个模块会发明自己的 throw 习惯，上层就无法统一处理；
 *   2. 本项目遵循「错误即数据」（ADR-004）：工具失败不抛异常，而是返回结构化结果，
 *      错误码因此必须先于工具协议定型；
 *   3. 对齐 zero2Agent 教程的 error taxonomy：8 类系统错误 + 5 类工具错误。
 *
 * 两套错误码的关系（刻意设计，别把它们合并）：
 *   - HarnessErrorCode（8 类）：模块之间传播的「主语言」，HarnessError 携带；
 *   - ToolErrorCode（5 类）：ToolResult.error.code 的取值，是「给模型看的」错误语言；
 *   - 其中 input_error / permission_denied / internal_error 三名重合是**故意的**——
 *     语义相同，直接映射；其余系统错误折叠为 service_error / internal_error
 *     （见下方 TOOL_CODE_MAP）。
 *
 * 依赖方向：本文件零依赖（全仓库最底层）。types.ts 从这里取 ToolErrorCode。
 * 演进提示：新增错误码时，三处必须同步——两个 as const 数组 + TOOL_CODE_MAP。
 */

// ---------------------------------------------------------------------------
// 系统级错误码（8 类）
// ---------------------------------------------------------------------------

/**
 * 用 `as const` 数组代替 TS `enum`：本项目开启 erasableSyntaxOnly（ADR-012），
 * enum 有运行时语义不可擦除，所以用「常量数组 + type 推导」实现同样效果——
 * 既有类型安全，又保留运行时可枚举性（可打印全部错误码）。
 */
export const HARNESS_ERROR_CODES = [
  'config_error', // 配置非法：启动期发现，不可重试（如预算分层合计与总量不一致）
  'input_error', // 调用方输入非法：工具参数、命令参数等，不可重试（先修输入）
  'provider_error', // 模型服务错误：网络/服务端 5xx，可重试
  'rate_limit_error', // 被限流：可重试，但退避时间应更长（指数退避 + 抖动）
  'timeout_error', // 超时：不可盲目立即重试，退避后重试
  'permission_denied', // 权限拒绝：不可自动重试（是决策不是故障，ADR-005）
  'context_overflow', // 上下文溢出：不可重试，正确路径是压缩而非重发
  'internal_error', // 兜底类：未分类的内部异常，从 unknown 归一化而来
] as const;

/** 系统级错误码联合类型：`'config_error' | 'input_error' | ...` */
export type HarnessErrorCode = (typeof HARNESS_ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// 工具级错误码（5 类，ADR-004）
// ---------------------------------------------------------------------------

/**
 * 工具错误码是「模型能看到」的失败原因：
 * 模型读到 input_error 会修正参数重试，读到 permission_denied 会换一条路，
 * 读到 service_error 可能稍后再试——所以码的语义必须稳定、可预期。
 */
export const TOOL_ERROR_CODES = [
  'input_error', // 参数不合法（schema 校验失败 / 业务校验失败）
  'service_error', // 工具依赖的外部服务出错（网络 / API 5xx）
  'timeout', // 工具执行超时（框架层超时保护触发）
  'permission_denied', // 权限层拒绝了这次调用
  'internal_error', // 工具自身 bug 或框架兜底包装的未知异常
] as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// 可重试判定
// ---------------------------------------------------------------------------

/** 可重试码的集合：只有「暂时性故障」才算，决策类与输入类错误重试无意义 */
const RETRYABLE_CODES: ReadonlySet<HarnessErrorCode> = new Set<HarnessErrorCode>([
  'provider_error',
  'rate_limit_error',
  'timeout_error',
]);

/** 判定某错误码是否属于「暂时性故障」（重试策略模块的唯一依据） */
export function isRetryableCode(code: HarnessErrorCode): boolean {
  return RETRYABLE_CODES.has(code);
}

// ---------------------------------------------------------------------------
// HarnessError：系统内传播的标准错误
// ---------------------------------------------------------------------------

export interface HarnessErrorOptions {
  /** 显式覆盖可重试性（默认按错误码推导）；用于少数上下文相关的特例 */
  retryable?: boolean;
  /** 错误发生的位置（模块名 / 文件名），便于日志定位，如 'llm/openai' */
  where?: string;
  /** 原始异常（Node 原生 Error 的 cause 机制，保留完整堆栈链） */
  cause?: unknown;
}

/**
 * 全系统统一错误类型。约定：
 *   - 模块间传播用 HarnessError（带 code / retryable / where）；
 *   - 工具内部不抛它——工具把失败转成 ToolResult（ADR-004）；
 *     框架层兜底 try/catch 时，用 toHarnessError() 把任意异常归一化。
 */
export class HarnessError extends Error {
  readonly code: HarnessErrorCode;
  readonly retryable: boolean;
  readonly where: string | undefined;

  constructor(code: HarnessErrorCode, message: string, options: HarnessErrorOptions = {}) {
    // ES2022 的 cause 机制：保留原始异常引用，日志/调试链路不断
    super(message, { cause: options.cause });
    this.name = 'HarnessError';
    this.code = code;
    // 默认按错误码推导可重试性，允许显式覆盖
    this.retryable = options.retryable ?? isRetryableCode(code);
    this.where = options.where;
  }
}

// ---------------------------------------------------------------------------
// 异常归一化与跨体系映射
// ---------------------------------------------------------------------------

/**
 * 把任意抛出物（unknown）归一化为 HarnessError。
 *
 * 使用场景：所有 catch 块的第一行。TS 的 catch 变量是 unknown，
 * 不归一化就无法安全访问 .message / .code——这是 strict 模式下
 * 「错误处理第一公里」的标准动作。
 *
 * 注意：AbortError（用户取消）不在这里特判——它是「控制流」不是「故障」，
 * 由感知 AbortSignal 的调用方（Dispatcher / Loop）自行识别处理。
 */
export function toHarnessError(err: unknown, where?: string): HarnessError {
  if (err instanceof HarnessError) return err;
  if (err instanceof Error) {
    return new HarnessError('internal_error', err.message, { cause: err, where });
  }
  return new HarnessError('internal_error', `非 Error 抛出物: ${String(err)}`, { where });
}

/**
 * AbortError 识别（取消是控制流，不是故障）。
 *
 * 为什么抽到错误库而不是各自文件里实现？
 *   「哪些异常算取消」的判断分散在多处（Dispatcher 执行链、AgentLoop 流迭代、
 *   未来 Sub-agent 并发池）——判断标准必须**全局一致**：一处把取消当错误
 *   吞掉、另一处又穿透，会产生极难排查的「有时能取消有时不能」现象。
 *
 * 识别依据是 name === 'AbortError' 而非 instanceof DOMException：
 *   AbortSignal.abort(reason) 允许自定义 reason；各 HTTP 客户端（fetch/undici）
 *   抛出的取消异常也不全是 DOMException——name 是跨实现的事实标准。
 */
export function isAbortError(raw: unknown): boolean {
  return raw instanceof Error && raw.name === 'AbortError';
}

/**
 * 系统错误码 → 工具错误码的映射表。
 * 用 Record 而非 switch：类型系统会强制这张表**穷尽**所有 HarnessErrorCode，
 * 将来新增错误码时忘记更新这里会直接编译报错（而不是运行时漏 case）。
 */
const TOOL_CODE_MAP: Record<HarnessErrorCode, ToolErrorCode> = {
  config_error: 'internal_error', // 配置错误对模型不可解释，折叠为内部错误
  input_error: 'input_error',
  provider_error: 'service_error',
  rate_limit_error: 'service_error',
  timeout_error: 'timeout',
  permission_denied: 'permission_denied',
  context_overflow: 'internal_error', // 溢出是框架要解决的问题，不该暴露给模型
  internal_error: 'internal_error',
};

/** 系统错误码 → 工具错误码（Dispatcher 包装兜底异常时使用） */
export function toToolErrorCode(code: HarnessErrorCode): ToolErrorCode {
  return TOOL_CODE_MAP[code];
}
