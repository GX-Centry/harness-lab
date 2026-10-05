/**
 * /status —— 当前会话的状态快照。
 *
 * 数据来源三处（体现了「控制面特权」——一个命令同时读多个内核模块）：
 *   - SessionManager.getSession：会话状态 + 消息数（编排层视角）
 *   - SessionStore.countCheckpoints：检查点数量（存储层视角）
 *   - config.session.checkpoint.mode：持久化策略（配置视角）
 *
 * 为什么时间显示用 ISO 字符串？命令输出要可复制、可对比（调试场景）——
 * 本地化格式（如「下午 3:42」）好看但不可比较。CLI 若要友好显示，
 * 在渲染层转换（命令层保持数据诚实）。
 */

import type { CommandDefinition, CommandResult } from '../types.ts';

export const statusCommand: CommandDefinition = {
  name: 'status',
  description: '显示当前会话状态（id / 状态 / 消息数 / 检查点数 / 时间）',
  usage: '/status',

  run(context): CommandResult {
    const info = context.manager.getSession(context.sessionId);
    if (info === undefined) {
      return {
        kind: 'text',
        text: `当前会话不存在：${context.sessionId}（先发一条消息或创建会话）`,
      };
    }
    const checkpoints = context.store.countCheckpoints(info.id);
    return {
      kind: 'text',
      text: [
        `会话 ${info.id}`,
        `  状态: ${info.state}`,
        `  消息: ${info.messageCount} 条，检查点: ${checkpoints} 个（mode=${context.config.session.checkpoint.mode}）`,
        `  创建: ${new Date(info.createdAt).toISOString()}`,
        `  更新: ${new Date(info.updatedAt).toISOString()}`,
      ].join('\n'),
    };
  },
};
