/**
 * /compact —— 上下文组装的 dry-run 预演。
 *
 * ===========================================================================
 * 重要取舍：v1 为什么是「只读预演」而不是「真正的压缩写回」？
 * ===========================================================================
 *
 * 用户的朴素预期：/compact 把历史压一压、腾出预算、接着聊。
 * 但在这套架构里，「写回压缩后的历史」会引爆一连串语义问题：
 *
 *   ① 检查点恢复会「复活」被压缩的消息。
 *      检查点存的是某一轮次边界的完整消息快照（w10 的恢复语义）。
 *      压缩删掉 10 条消息后崩溃，resumeSession 按检查点恢复——
 *      删掉的消息全回来了。「压缩在重启后失效」是难以向用户解释的行为。
 *
 *   ② 消息 id 与工具协议的关联会被破坏。
 *      assistant(tool_calls) ↔ tool(结果) 必须成对（协议约束）。
 *      朴素地「删旧消息」极易拆散配对，把下一个请求变成协议错误。
 *
 *   ③ 会话历史 ≠ 请求上下文，两者不必一致。
 *      历史是「记录」（审计、回看），上下文是「投影」（每次请求即时计算）。
 *      本架构的正确做法：**上下文压缩发生在组装时**（ContextManager.build
 *      的压缩链，每个请求即时计算、原始历史不动）——压缩本来就不需要
 *      「写入历史」这个动作。
 *
 * 那 /compact 还有什么用？——它是「预算体检工具」：
 *   把「若此刻发起请求会发生什么压缩」摊开给用户看（分层占用、压缩记录、
 *   警告），用于排查「为什么模型忘了前文」（大概率是历史层被压缩了）。
 *
 * 演进路径（如果真需要「持久化压缩」）：
 *   引入「摘要消息」机制——压缩时不删消息，而是追加一条 role:system 的
 *   摘要并标记边界（boundary 元数据），恢复时按边界重放。
 *   这需要 store 的 schema 扩展（消息表加 boundary 列）+ 检查点语义升级。
 *   v1 不做：涉及持久化协议变更，收益（省内存）在当前规模下不存在。
 */

import type { CommandDefinition, CommandResult } from '../types.ts';

export const compactCommand: CommandDefinition = {
  name: 'compact',
  description: '预演一次上下文组装（dry-run）：展示分层 token 占用与压缩链报告，不修改历史',
  usage: '/compact',

  run(context): CommandResult {
    // ---- 依赖缺省的显式降级（不静默失败）----
    const contextManager = context.contextManager;
    if (contextManager === undefined) {
      return {
        kind: 'text',
        text: '未装配 ContextManager（本装配不支持 /compact）。',
      };
    }

    const messages = context.store.loadMessages(context.sessionId);
    if (messages.length === 0) {
      return { kind: 'text', text: `会话 ${context.sessionId} 暂无消息，无需压缩。` };
    }

    // ---- dry-run：真跑一遍组装链，但只用报告、丢弃结果消息 ----
    // queryId 用固定值而非随机：命令不产生真实 LLM 请求，事件关联不需要
    // 唯一性；固定值让「同状态下的 /compact 事件」可复现对比（教学/调试友好）。
    const { report } = contextManager.build(messages, {
      sessionId: context.sessionId,
      queryId: 'command:compact',
    });

    const layerLine = (Object.entries(report.layerTokens) as [string, number][])
      .map(([name, tokens]) => `${name}=${tokens}`)
      .join('  ');

    const lines = [
      `上下文预演（会话 ${context.sessionId}，输入 ${messages.length} 条消息）:`,
      `  总占用: ${report.totalTokens} tok（预算 ${context.config.context.maxTotalTokens} tok）`,
      `  分层: ${layerLine}`,
      `  压缩: ${report.compressed ? '已触发' : '未触发'}`,
    ];
    for (const record of report.compressions) {
      lines.push(
        `    - [L${record.level}] ${record.description}（-${record.droppedMessages} 条 / -${record.droppedTokens} tok）`,
      );
    }
    for (const warning of report.warnings) {
      lines.push(`  ⚠ ${warning}`);
    }
    lines.push('  （dry-run：仅展示「若此刻请求会发生什么」，历史未被修改）');

    return { kind: 'text', text: lines.join('\n') };
  },
};
