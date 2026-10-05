/**
 * truncate-result hook —— 工具结果的上下文保护。
 *
 * 背景：工具输出（日志、文件内容、大数据查询）是上下文爆炸的第一大来源。
 * 本 hook 在结果进入对话历史前截断：保留头部（通常是最相关的开头）
 * 与尾部（结论/错误往往在末尾），中间用显式标记替代。
 *
 * 与 Context 层压缩的分工（重要）：
 *   本 hook 作用于「单条结果的首次入库」——一次截断，永久生效；
 *   Context 压缩（w09）作用于「累积历史超预算时」——动态降级。
 *   两者是「入口控制」与「总量控制」的关系。
 *
 * 标记文本刻意包含「省略 N 字符」：让模型知道信息不完整——
 * 静默截断会让模型把残缺内容当作全量事实（幻觉的经典来源之一）。
 */

import type { Hook } from '../../types.ts';
import { replaceResultContent } from './shared.ts';

export interface TruncateResultOptions {
  /** 超过该字符数即截断；默认 4000（约 1000 token，对齐工具输出的常见合理上限） */
  readonly maxChars?: number;
  /** 头部保留比例（默认 0.6） */
  readonly headRatio?: number;
  /** 尾部保留比例（默认 0.3） */
  readonly tailRatio?: number;
}

export function createTruncateResultHook(options: TruncateResultOptions = {}): Hook {
  const maxChars = options.maxChars ?? 4000;
  const headRatio = options.headRatio ?? 0.6;
  const tailRatio = options.tailRatio ?? 0.3;

  return {
    name: 'truncate-result',
    priority: 30,
    events: ['tool_call_after'],
    async handler(payload) {
      const result = payload.result;
      if (result === undefined) return { kind: 'continue' };
      if (result.content.length <= maxChars) return { kind: 'continue' };

      const headLen = Math.floor(maxChars * headRatio);
      const tailLen = Math.floor(maxChars * tailRatio);
      const omitted = result.content.length - headLen - tailLen;
      const truncated =
        `${result.content.slice(0, headLen)}\n` +
        `...[已省略 ${omitted} 字符]...\n` +
        result.content.slice(-tailLen);
      return { kind: 'modify_result', result: replaceResultContent(result, truncated) };
    },
  };
}
