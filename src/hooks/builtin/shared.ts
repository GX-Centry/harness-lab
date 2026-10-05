/**
 * 内置 hook 的共享工具函数。
 * stableStringify 是「签名类」逻辑（去重/熔断）的基础：
 * 同一份参数对象，无论键的书写顺序如何，都必须生成相同签名——
 * 否则「重试 N 次相同调用」可能因为键序变化而漏检。
 */

import type { ToolResult } from '../../types.ts';
import { failedResult, okResult } from '../../types.ts';

/**
 * 稳定序列化：对象键排序后递归序列化（数组保持原序——顺序是语义的一部分）。
 * 教学点：JSON.stringify 直接输出的键序取决于对象构造顺序（插入序），
 * 作为「内容签名」不可靠；稳定序列化让签名与键序解耦。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** 截断为简报（日志与审计摘要用）：超长时保留头部 + 省略标记 */
export function brief(text: string, maxChars = 120): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…(+${text.length - maxChars})`;
}

/**
 * 保持判别联合形状地替换结果内容。
 * redact / truncate 这类「结果加工」hook 共用：ok / error 结构必须原样保留，
 * 只换 content——直接 { ...result, content } 会绕过工厂函数的形状保证。
 */
export function replaceResultContent(result: ToolResult, content: string): ToolResult {
  if (result.ok) {
    return okResult(content, result.meta);
  }
  return failedResult(result.error.code, result.error.message, content);
}
