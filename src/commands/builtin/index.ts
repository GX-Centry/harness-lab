/**
 * 内置命令集合 —— 控制面的最小可用户子集。
 *
 * 组装顺序即 /help 的展示顺序（注册顺序 = 列表顺序）。
 * 注意 help 是工厂（需要 registry 引用），其余直接导出常量——
 * 差异原因见 help.ts 文件头。
 */

import type { CommandDefinition } from '../types.ts';
import type { CommandRegistry } from '../registry.ts';
import { createHelpCommand } from './help.ts';
import { statusCommand } from './status.ts';
import { historyCommand } from './history.ts';
import { compactCommand } from './compact.ts';
import { skillCommand } from './skill.ts';
import { modeCommand } from './mode.ts';
import { hooksCommand } from './hooks.ts';

export { createHelpCommand, statusCommand, historyCommand, compactCommand, skillCommand, modeCommand, hooksCommand };

/**
 * 返回全部内置命令的工厂。
 *
 * @param registry 由调用方创建并传入（help 命令闭包引用它读取命令列表）。
 *   装配姿势（CLI/lab 同款）：
 *     const registry = new CommandRegistry();
 *     for (const command of createBuiltinCommands(registry)) registry.register(command);
 */
export function createBuiltinCommands(registry: CommandRegistry): CommandDefinition[] {
  return [
    createHelpCommand(registry),
    statusCommand,
    historyCommand,
    compactCommand,
    skillCommand,
    modeCommand,
    hooksCommand,
  ];
}
