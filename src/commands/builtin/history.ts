/**
 * /history —— 消息历史预览。
 *
 * 与 /compact 的分工：/history 看「聊了什么」（消息内容），
 * /compact 看「上下文怎么组装」（token 预算视角）。
 *
 * 参数防呆（控制面命令需要验证用户输入）：
 *   - 非正整数 → 明确提示（而不是静默回退默认值——用户以为改了其实没改，
 *     是比报错更糟的体验）；
 *   - 超上限 → 截到上限并说明（防「/history 999999」把终端刷爆）。
 */

import type { Message } from '../../types.ts';
import type { CommandDefinition, CommandResult } from '../types.ts';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
/** 单条消息的预览长度（多行折叠为一行后截断） */
const PREVIEW_CHARS = 80;

export const historyCommand: CommandDefinition = {
  name: 'history',
  description: '显示当前会话最近的消息（默认 10 条，上限 50 条）',
  usage: '/history [n]',

  run(context, args): CommandResult {
    // ---- 参数解析（防呆）----
    let limit = DEFAULT_LIMIT;
    const raw = args[0];
    if (raw !== undefined) {
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return {
          kind: 'text',
          text: `参数无效："${raw}"——应为正整数（例如 /history 5）。`,
        };
      }
      limit = Math.min(parsed, MAX_LIMIT);
    }

    // ---- 数据源：存储层的完整消息（含 system）----
    const messages = context.store.loadMessages(context.sessionId);
    if (messages.length === 0) {
      return { kind: 'text', text: `会话 ${context.sessionId} 暂无消息。` };
    }

    const start = Math.max(0, messages.length - limit);
    const lines = messages.slice(start).map((message, i) => {
      const index = start + i + 1; // 全局序号（1 基）——对得上「第几条」
      return `  #${index} ${label(message)} ${preview(message.content)}`;
    });
    const note =
      messages.length > limit
        ? `（共 ${messages.length} 条，显示最近 ${messages.length - start} 条；上限 ${MAX_LIMIT}）`
        : `（共 ${messages.length} 条）`;
    return {
      kind: 'text',
      text: [`会话 ${context.sessionId} ${note}:`, ...lines].join('\n'),
    };
  },
};

/** 角色标签（tool 消息带工具名——排查「哪个工具产出了这段内容」的关键信息） */
function label(message: Message): string {
  return message.role === 'tool' ? `[tool:${message.name}]` : `[${message.role}]`;
}

/** 单行预览：换行折叠 + 截断 + 省略号（终端输出必须折叠多行，否则刷屏） */
function preview(content: string): string {
  const single = content.replaceAll(/\s+/g, ' ').trim();
  return single.length > PREVIEW_CHARS ? `${single.slice(0, PREVIEW_CHARS)}…` : single;
}
