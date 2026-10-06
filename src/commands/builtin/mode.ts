/**
 * /mode —— 权限模式的查看与运行期切换（「全自动 / 半自动」的控制面入口）。
 *
 * ===========================================================================
 * 必答问题：为什么模式切换要做成命令而不是启动参数就够了？
 * ===========================================================================
 * 启动参数（--mode）决定「起步姿态」，但真实使用中的姿态是**流动的**：
 *   - 演示/无人值守一段时间 → auto；回到有人看着的探索 → manual；
 *   - 跑一个已知安全的流程 → semi；碰到敏感操作想逐步盯 → 切回 manual。
 * 每次切换都重启进程是荒谬的——命令层就是这种「运行姿态调整」的天然位置
 * （控制面：用户对系统的元操作，与 /compact、/skill 同级）。
 *
 * 语义承诺（与 gate.ts 的 autoApproveByMode 一一对应）：
 *   /mode          查看当前模式（含一句话描述——用户不用记档位含义）；
 *   /mode <m>      切换到指定模式（立即对后续每次权限检查生效）。
 *
 * 边界说明（写进帮助文本，防止误解）：
 *   模式只影响 **confirm 层**——规则 deny 仍拒绝、hook block 仍阻断；
 *   auto 不是「关掉权限系统」，是「confirm 决策自动盖章」。
 */

import { describePermissionMode, parsePermissionMode, PERMISSION_MODES } from '../../permission/modes.ts';
import type { CommandDefinition, CommandResult } from '../types.ts';

export const modeCommand: CommandDefinition = {
  name: 'mode',
  description: '查看或切换权限模式（manual 全手动 / semi 半自动 / auto 全自动）',
  usage: '/mode [manual|semi|auto]',

  run(context, args): CommandResult {
    // ---- 依赖缺省的显式降级（与 /skill 同款）----
    const controller = context.permissionMode;
    if (controller === undefined) {
      return { kind: 'text', text: '未装配权限模式控制器（本装配不支持 /mode）。' };
    }

    // ---- 模式一：/mode —— 查看当前模式 ----
    const [target] = args;
    if (target === undefined) {
      return {
        kind: 'text',
        text: [
          `当前权限模式：${controller.mode}`,
          `  ${describePermissionMode(controller.mode)}`,
          `  可选：${PERMISSION_MODES.join(' / ')}（用 /mode <name> 切换）`,
        ].join('\n'),
      };
    }

    // ---- 模式二：/mode <name> —— 切换 ----
    const parsed = parsePermissionMode(target);
    if (parsed === undefined) {
      return {
        kind: 'text',
        text: `未知模式 "${target}"。可选：${PERMISSION_MODES.join(' / ')}。`,
      };
    }
    controller.setMode(parsed);
    return {
      kind: 'text',
      text: `权限模式已切换：${parsed}\n  ${describePermissionMode(parsed)}`,
    };
  },
};
