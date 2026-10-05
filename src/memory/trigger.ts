/**
 * trigger —— 记忆写入白名单：「该不该记 / 记成什么类型」的确定性判断。
 *
 * 必答问题（03-module-guide §2.9）：「该记什么」的判断在 trigger 还是模型？
 *   选择 trigger（规则白名单）的代价与理由：
 *   - 模型判断（提供 save_memory 工具让模型自己调用）：灵活，但不可靠
 *     （可能不调用、可能噪声调用）、每轮多一份工具面、行为不可确定测试；
 *   - 规则判断：完全确定、离线可测、可解释（每条记忆能回答「为什么被记」），
 *     覆盖有限（只认显式信号）。
 *   两者不互斥：演进路径 = 规则作「保底通道」+ 模型工具作「主动通道」，
 *   工具实现复用本文件的判定逻辑做二次过滤。
 *
 * 触发点为什么挂在 query 终结（而非 post-tool hook）：
 *   01-architecture 的 hook 清单曾把「记忆触发」列为 post-tool hook #30；
 *   实现时改挂 SessionManager 的 query 终结——**冲突点显式标注**：
 *   ① 记忆的信号源是「一整轮对话」（用户输入 + 结局），不是单个工具结果；
 *   ② post-tool 挂点每工具触发一次——同一 query 重复检查、信号还很弱；
 *   ③ 数据流图（01-architecture §3）本就把「Memory 触发检查」画在
 *      「回答回写 session」之后、Loop 退出之前——query 级语义；
 *   ④ 未来若确实需要 per-tool 触发：本文件是纯函数，hook 层可直接复用
 *     （改造成本≈零，只是多一个调用点）。
 *
 * v1 白名单（宁少勿滥——记忆库被噪声污染比漏记一条更糟）：
 *   R1 显式记忆请求：「请记住 / 记下 / 别忘了 / remember …」→ 提取请求内容。
 *       kind 判定：内容含偏好标志词 → preference；否则 fact。
 *   R2 偏好自动捕获（注释保留、暂不启用）：「我喜欢 X」类陈述自动入库——
 *       无显式信号时过度捕获风险高（每句偏好陈述都记 → 污染），
 *       需配套「用户确认 / 撤销」机制后再启用（演进点）。
 *
 * 依赖方向：memory/trigger.ts → memory/store.ts（MemoryKind 类型）。
 *           纯函数无状态——测试可逐规则枚举。
 */

import type { MemoryKind } from './store.ts';

// ===========================================================================
// §1 规则常量
// ===========================================================================

/**
 * R1：显式记忆请求的触发词（中英；前后允许「请 / 帮我」类礼貌前缀）。
 * 为什么不含「记得」：「你还记得…」是回忆陈述不是请求——弱信号词会误伤
 * （白名单原则：宁少勿滥，误报比漏报更糟）。
 */
const REQUEST_PATTERN = /(?:请|帮我|麻烦)?(?:记住|记下|牢记|别忘了|别忘|remember)[:：,，。!！\s]*/i;

/** 偏好标志词：决定记录归档为 preference 还是 fact */
const PREFERENCE_MARKERS = [
  '偏好',
  '习惯',
  '喜欢',
  '讨厌',
  '不喜欢',
  '风格',
  'prefer',
  'preference',
  'like',
] as const;

/** 提取出的内容少于该长度 → 视为「没有可记的内容」（如仅一句「记住！」） */
const MIN_CONTENT_LENGTH = 2;

// ===========================================================================
// §2 判定输出
// ===========================================================================

/** 一条「应当写入」的决策（触发点消费它去调 MemoryStore.write） */
export interface MemoryDecision {
  readonly kind: MemoryKind;
  /** 要记住的内容（已剥离触发词的正文） */
  readonly content: string;
  /** 命中的规则名（事件与日志展示「为什么记这条」——可解释性） */
  readonly rule: string;
}

// ===========================================================================
// §3 判定入口
// ===========================================================================

/**
 * 对一次「完整 query 上下文」做白名单判定。
 *
 * v1 只看用户输入（显式请求必然出现在输入里）；参数保留 finalText /
 * stopReason 是为了 R2 及「任务结论」类规则未来启用时签名稳定——
 * 显式标注：v1 实现未消费这两个字段（诚实优于假装）。
 *
 * @returns 0~n 条决策（v1 最多 1 条；返回数组保证规则扩展时形状不变）
 */
export function decideMemoryWrites(args: {
  readonly input: string;
  readonly finalText: string | undefined;
  readonly stopReason: string;
}): readonly MemoryDecision[] {
  const explicit = matchExplicitRequest(args.input);
  return explicit === undefined ? [] : [explicit];
}

// ===========================================================================
// §4 规则实现
// ===========================================================================

/**
 * R1：显式记忆请求。
 * 提取策略：删去「首个触发短语」及其后的标点，剩余正文即内容；
 * 正文过短（< MIN_CONTENT_LENGTH）→ 不触发（「记住！」单独一句没有可记之物）。
 */
function matchExplicitRequest(input: string): MemoryDecision | undefined {
  if (!REQUEST_PATTERN.test(input)) return undefined;
  // 只去除第一个触发短语（replace 非全局）：多个请求场景留待演进
  const stripped = input.replace(REQUEST_PATTERN, '').trim();
  if (stripped.length < MIN_CONTENT_LENGTH) return undefined;
  return {
    kind: classifyKind(stripped),
    content: stripped,
    rule: 'explicit_request',
  };
}

/** 内容含偏好标志词 → preference；否则事实性内容 → fact */
function classifyKind(content: string): MemoryKind {
  const lowered = content.toLowerCase();
  for (const marker of PREFERENCE_MARKERS) {
    if (lowered.includes(marker)) return 'preference';
  }
  return 'fact';
}
