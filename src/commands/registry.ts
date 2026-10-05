/**
 * CommandRegistry —— 命令注册表。
 *
 * 与 ToolRegistry / SkillRegistry 的差异（本项目注册表模式的第三处应用）：
 *   - 名字大小写：命令名是**用户输入协议**——用户打 /Status 也应该命中。
 *     策略：注册时强制全小写（拒绝大小写混写，保持数据干净），
 *     查询时对入参做 toLowerCase() 归一（对用户宽容）。
 *   - 无 schema 校验：命令参数按位置解析（string[]），不做结构化声明——
 *     控制面参数极少且各异，结构化 schema 是过度设计（需要时在命令
 *     实现内用 zod 校验，如 /history 的 n 参数）。
 */

import { HarnessError } from '../errors.ts';
import type { CommandDefinition } from './types.ts';

export class CommandRegistry {
  private readonly commands = new Map<string, CommandDefinition>();

  /**
   * 注册命令（幂等失败：重名立即抛 config_error）。
   * 名字校验：非空 + 全小写 + 不含空白（空白会破坏解析协议）。
   */
  register(command: CommandDefinition): this {
    if (command.name === '' || command.name !== command.name.toLowerCase()) {
      throw new HarnessError(
        'config_error',
        `命令名必须是全小写的非空字符串: "${command.name}"（命令名是用户输入协议，注册时强制归一）`,
        { where: 'commands/registry' },
      );
    }
    if (/\s/.test(command.name)) {
      throw new HarnessError('config_error', `命令名不能包含空白: "${command.name}"`, {
        where: 'commands/registry',
      });
    }
    if (this.commands.has(command.name)) {
      throw new HarnessError('config_error', `命令名重复注册: "${command.name}"`, {
        where: 'commands/registry',
      });
    }
    this.commands.set(command.name, command);
    return this;
  }

  /** 按名查找（入参自动小写归一）；未找到返回 undefined——由 router 决定如何提示 */
  get(name: string): CommandDefinition | undefined {
    return this.commands.get(name.toLowerCase());
  }

  has(name: string): boolean {
    return this.commands.has(name.toLowerCase());
  }

  /** 全部命令（按注册顺序——/help 输出可复现） */
  list(): readonly CommandDefinition[] {
    return [...this.commands.values()];
  }

  get size(): number {
    return this.commands.size;
  }
}
