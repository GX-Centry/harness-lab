/**
 * /hooks —— 已注册 hook 的只读展示（「横切逻辑可见性」的控制面入口）。
 *
 * ===========================================================================
 * 必答问题：hook 在两种模式下都正常运行，为什么还需要这个命令？
 * ===========================================================================
 * 诊断「hook 等其它领域是否也无法访问」时的实际发现：hook 管道在演示与
 * 真实两种装配下**都在运行**（repeat-guard / audit / redact / truncate），
 * 但 CLI 壳没有订阅事件总线（那是 Web 壳的可视化通道）——用户在 CLI 里
 * **看不见**任何 hook 的存在。不可见 = 不可信/不可调试（用户会误以为
 * hook 没生效）。
 *
 * 修复不是「把 hook 变成模型工具」（hook 是框架级横切逻辑，本就不该由
 * 模型调用——见 types.ts 的插槽协议），而是补上**可见性**：本命令静态
 * 列出管道里挂了哪些 hook、各自的优先级与监听事件——「装配了什么」一眼
 * 可查（执行踪迹仍走事件流，由 Web 壳的可观察面板消费）。
 */

import type { CommandDefinition, CommandResult } from '../types.ts';

export const hooksCommand: CommandDefinition = {
  name: 'hooks',
  description: '列出已注册的 hook（横切管道：脱敏 / 审计 / 熔断 / 截断等）',
  usage: '/hooks',

  run(context): CommandResult {
    // ---- 依赖缺省的显式降级（与 /skill 同款）----
    const pipeline = context.hooks;
    if (pipeline === undefined) {
      return { kind: 'text', text: '未装配 hook 管道（本装配不支持 /hooks）。' };
    }

    const hooks = pipeline.registeredHooks;
    if (hooks.length === 0) {
      return { kind: 'text', text: '未注册任何 hook（管道为空——所有插槽直通）。' };
    }

    // 按执行顺序展示（pipeline 已按 priority 稳定排序——展示顺序 = 真实执行顺序）
    const lines = hooks.map(
      (hook) => `  ${hook.name}（priority ${hook.priority}，监听 ${hook.events.join(' / ')}）`,
    );
    return {
      kind: 'text',
      text: [
        `已注册 hook（${hooks.length} 个，按执行顺序——数字小者先执行）:`,
        ...lines,
        '注：hook 事件（hook_invoked / hook_outcome / hook_error）可在 Web 控制台的时间线中查看。',
      ].join('\n'),
    };
  },
};
