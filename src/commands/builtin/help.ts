/**
 * /help —— 命令自述文档。
 *
 * 设计要点：help 需要读「注册表里有什么」——这是唯一一个对注册表有依赖的
 * 内置命令，所以它是**工厂函数**（createHelpCommand(registry)），在装配时
 * 由 createBuiltinCommands 把 registry 闭包进来。其余命令直接导出常量。
 *
 * 这个「工厂 vs 常量」的区别本身是教学点：命令的依赖从哪来——
 *   ① 环境依赖（manager/store/context/config）→ 走 CommandContext（运行时注入）；
 *   ② 结构依赖（注册表自身）→ 走工厂闭包（装配时注入）。
 */

import type { CommandRegistry } from '../registry.ts';
import type { CommandDefinition, CommandResult } from '../types.ts';

export function createHelpCommand(registry: CommandRegistry): CommandDefinition {
  return {
    name: 'help',
    description: '列出全部命令，或查看单个命令的用法',
    usage: '/help [command]',

    run(_context, args): CommandResult {
      const target = args[0];

      // ---- 模式一：/help —— 全量列表 ----
      if (target === undefined) {
        const commands = registry.list();
        const lines = commands.map((c) => `  /${c.name}  ${c.description}`);
        return {
          kind: 'text',
          text: [`可用命令（${commands.length} 个）:`, ...lines].join('\n'),
        };
      }

      // ---- 模式二：/help <command> —— 单命令详情（容忍用户顺手写 /help /status）----
      const name = target.startsWith('/') ? target.slice(1) : target;
      const command = registry.get(name);
      if (command === undefined) {
        return {
          kind: 'text',
          text: `未知命令：/${name}。输入 /help 查看全部命令。`,
        };
      }
      return {
        kind: 'text',
        text: [
          `/${command.name}`,
          `  说明: ${command.description}`,
          `  用法: ${command.usage ?? `/${command.name}`}`,
        ].join('\n'),
      };
    },
  };
}
