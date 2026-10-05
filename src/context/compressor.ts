/**
 * 压缩工具集 —— 上下文预算守门员的「减压阀」。
 *
 * 压缩链（从便宜到贵、从无损到有损；级别与 events.context_compressed.level 对应）：
 *   L1 工具输出截断：单条 tool 消息超限 → 头尾保留 + 省略标记（最先做——
 *      工具输出是上下文爆炸的第一大来源，且单条压缩零语义损失）；
 *   L2 丢弃最老轮次 + 占位：从最老的「轮次组」开始丢，插入省略说明；
 *   L3 规则摘要折叠：老消息全部折叠为一条摘要（每条取片段，保留脉络）；
 *   L4 摘要截断：摘要本身仍超限 → 截到预算内（保底层，保证进程不死）。
 *
 * 为什么 v1 用「规则摘要」而不是「LLM 摘要」？
 *   - LLM 摘要是异步 + 额外模型调用（成本、失败模式、延迟都多一跳）；
 *   - 规则摘要完全确定（同输入同输出）——可测试、零依赖、可离线；
 *   - LLM 摘要是明确的演进点：注入 provider 后替换本模块的一个函数即可
 *     （ContextManager 的调用面不变）。「先有确定性保底、再有质量升级」
 *     是压缩子系统的正确演进顺序。
 *
 * 为什么按「轮次组」而不按「单条消息」处理？——协议完整性：
 *   assistant(tool_calls) 与其配对的 tool 结果不能被切散（真实 Provider
 *   对此是强校验）。分组规则见 manager.ts 的 groupMessages()。
 *
 * 依赖方向：context/compressor.ts → types.ts / tokens.ts（纯函数，零 IO）。
 */

import type { Message, ToolMessage, UserMessage } from '../types.ts';
import { MESSAGE_OVERHEAD_TOKENS, messageTokens } from './tokens.ts';
import type { TokenCounter } from './tokens.ts';

// ===========================================================================
// §1 压缩记录（审计与事件载体）
// ===========================================================================

/** 压缩链的级别（1-4，语义见文件头） */
export type CompressionLevel = 1 | 2 | 3 | 4;

/**
 * 一条压缩记录。
 * 为什么要记录：用户看到「这轮回答怎么变笨了」时，需要能回溯到
 * 「第 N 轮触发了 L2 丢弃」——压缩必须是可观测的，否则是玄学。
 */
export interface CompressionRecord {
  readonly level: CompressionLevel;
  /** 人类可读的说明（审计日志用） */
  readonly description: string;
  /** 因此记录而被丢弃/折叠的消息条数（L1 恒为 0——它只压缩不丢弃） */
  readonly droppedMessages: number;
  /** 节省的 token 估算（压缩前 - 压缩后） */
  readonly droppedTokens: number;
}

// ===========================================================================
// §2 L1：工具输出截断
// ===========================================================================

/**
 * 把文本截到 token 预算内：保留头尾，中间以省略标记代替。
 *
 * 为什么用二分查找而不是「每 token N 字符」线性反推：
 *   count 是任意单调函数（Fake 的 CJK 公式、真实 tokenizer 的分词规则
 *   都不是线性的），线性除法会算出「以为装下了其实超了」的结果。
 *   二分是唯一对单调函数普遍正确的做法，且 O(log n) 次字符串构造
 *   对「偶尔发生」的压缩场景完全可接受。
 *
 * 为什么按 code point（Array.from）切分：
 *   直接 slice 按 UTF-16 单元切会切开 emoji 的代理对，产出「半个字符」
 *   ——与 FakeProvider.splitChunks 的教训一致。
 */
export function truncateToTokenBudget(
  text: string,
  budget: number,
  count: TokenCounter,
  headRatio = 0.6,
): string {
  if (count(text) <= budget) return text;
  const chars = Array.from(text);
  const total = chars.length;

  // 二分：找最大的 keepChars，使「头 + 标记 + 尾」在预算内
  let lo = 0;
  let hi = total - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (count(buildTruncated(chars, mid, headRatio)) <= budget) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // 连 keepChars=0（只剩标记）都超预算时 best=-1：返回标记本身——
  // 「有省略」这个事实比「完全静默丢弃」对模型更有价值（保底策略）。
  return buildTruncated(chars, best >= 0 ? best : 0, headRatio);
}

/** 头尾保留构造：头 60% / 尾 40% 的经典比例（把「最新信息」放在尾部也有利） */
function buildTruncated(chars: string[], keepChars: number, headRatio: number): string {
  const total = chars.length;
  if (keepChars >= total) return chars.join('');
  const head = Math.ceil(keepChars * headRatio);
  const tail = keepChars - head;
  const omitted = total - head - tail;
  const marker = `…[已省略 ${omitted} 字符]…`;
  return (
    chars.slice(0, head).join('') +
    marker +
    (tail > 0 ? chars.slice(total - tail).join('') : '')
  );
}

/**
 * L1：压缩单条 tool 消息到 token 预算。
 * 返回新消息对象（build 是纯函数式变换——**永不修改传入的历史**，
 * 会话存储里的原始数据必须保持完整，这关系到可审计性）。
 */
export function compressToolMessage(
  message: ToolMessage,
  budget: number,
  count: TokenCounter,
): { readonly message: ToolMessage; readonly record: CompressionRecord | undefined } {
  const before = messageTokens(message, count);
  if (before <= budget) {
    return { message, record: undefined };
  }
  // 预留结构开销：内容预算 = 消息预算 - 固定余量
  const contentBudget = Math.max(1, budget - MESSAGE_OVERHEAD_TOKENS);
  const compressed = truncateToTokenBudget(message.content, contentBudget, count);
  const after = messageTokens({ ...message, content: compressed }, count);
  return {
    message: { ...message, content: compressed },
    record: {
      level: 1,
      description: `工具输出超限压缩（${message.name}: ${before} → ${after} tok）`,
      droppedMessages: 0, // L1 不丢消息，只压缩内容
      droppedTokens: before - after,
    },
  };
}

// ===========================================================================
// §3 L2：丢弃占位 / L3-L4：规则摘要
// ===========================================================================

/**
 * L2 占位消息：声明「较早的消息被省略」。
 * 角色选择用的是 user（而非 system）：system 在规范形约定数组首位，
 * 中途插入会破坏适配层「system 抽离到顶层字段」的假设；user 承载
 * 「外部提供给模型的信息」语义，配 [系统提示] 前缀已足够清晰。
 * （替代方案：并入 system 顶部的注入段落——牺牲「省略点」在时间线上的
 *  精确位置，收益是消息数组更干净。选当前方案是为了位置语义。）
 */
export function omissionMessage(droppedCount: number): UserMessage {
  return {
    role: 'user',
    content: `[系统提示] 较早的 ${droppedCount} 条对话消息因上下文预算限制已被省略（原始内容保存在会话存储中，可按需检索）。`,
  };
}

/** 摘要中每条消息保留的片段长度（字符） */
export const SUMMARY_SNIPPET_CHARS = 80;

/**
 * L3：把一批老消息折叠为一条规则摘要消息。
 * 摘要形态：「每条消息一行、取前 N 字符」——保留对话脉络（谁说了什么、
 * 调了哪些工具），牺牲细节。对模型而言「知道发生过什么」通常比
 * 「精确记得每个字」更重要。
 */
export function foldToSummaryMessage(messages: readonly Message[]): UserMessage {
  const lines: string[] = [
    `[系统提示] 较早的 ${messages.length} 条对话消息因上下文预算被压缩为以下摘要（原始内容保存在会话存储中）：`,
  ];
  for (const message of messages) {
    lines.push(snippetOf(message));
  }
  return { role: 'user', content: lines.join('\n') };
}

/** 单条消息的摘要片段 */
function snippetOf(message: Message): string {
  const flat = message.content.replace(/\s+/g, ' ').trim();
  const clipped =
    flat.length > SUMMARY_SNIPPET_CHARS ? `${flat.slice(0, SUMMARY_SNIPPET_CHARS)}…` : flat;
  switch (message.role) {
    case 'user':
      return `- [用户] ${clipped}`;
    case 'assistant': {
      const callNames = message.toolCalls?.map((call) => call.name).join('/');
      return callNames !== undefined && callNames !== ''
        ? `- [AI → 调用工具 ${callNames}] ${clipped}`
        : `- [AI] ${clipped}`;
    }
    case 'tool':
      return `- [工具 ${message.name}] ${clipped}`;
    case 'system':
      // system 在 manager 中已被提前提取，正常不会走到这里（穷尽检查需要）
      return `- [系统] ${clipped}`;
  }
}
