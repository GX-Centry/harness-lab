/**
 * CommandRouter —— 命令拦截器（REPL 的「前置分流器」）。
 *
 * ===========================================================================
 * 挂点位置：「进 LLM 之前」的工程落地
 * ===========================================================================
 *
 *   REPL 消费循环（CLI w17 / lab 演示）：
 *
 *     const handled = await router.tryHandle(input, sessionId);
 *     if (handled !== undefined) {
 *       render(handled.text);              // ← 命令路径：不进模型、不进会话
 *     } else {
 *       for await (const ev of manager.runQuery(...)) ... // ← 对话路径
 *     }
 *
 *   这个三分支结构就是「拦截」的全部含义——命令在编排层**之前**被消化，
 *   SessionManager 与 Loop 完全不知道命令存在（依赖方向硬约束，见 types.ts）。
 *
 * ---------------------------------------------------------------------------
 * 为什么 router 用 buildContext 回调而不是直接持有依赖？
 * ---------------------------------------------------------------------------
 *   依赖倒置：router 需要「当前会话的 CommandContext」（含 manager/store/
 *   contextManager/skills...），但它不应该知道这些对象怎么组装、由谁持有。
 *   调用方传入 `(sessionId) => CommandContext` 闭包——router 只负责
 *   「解析 → 查表 → 执行 → 事件」，环境组装的责任留给装配层。
 *   收益：同一 router 在 CLI、lab、测试里可挂不同的上下文实现（如测试用
 *   :memory: 存储构造轻量上下文）。
 *
 * ---------------------------------------------------------------------------
 * 事件语义（command_invoked / command_finished，events.ts 已预定义）
 * ---------------------------------------------------------------------------
 *   - 未知命令**不发射**事件：没有命令被真实调用，发 invoked 会污染统计；
 *   - 命令执行抛异常 → command_finished.ok=false + 错误文本返回给用户：
 *     控制面必须「稳态」（用户打错参数不该崩掉 REPL——命令内部异常在这里
 *     转换为止，与工具层的「错误即数据」哲学一致）；
 *   - durationMs 用注入时钟（now），测试可断言可预测时长。
 */

import type { EventBus } from '../kernel/events.ts';
import { parseCommand } from './parser.ts';
import type { CommandRegistry } from './registry.ts';
import type { CommandContext, CommandResult } from './types.ts';

export interface CommandRouterOptions {
  readonly registry: CommandRegistry;
  readonly bus: EventBus;
  /**
   * 上下文组装回调（依赖倒置核心）：按会话 id 构造 CommandContext。
   * 注意是**每次执行时调用**（command.run 之前）——保证上下文反映最新状态
   * （如 /status 读到的是刚写入的消息数）。
   */
  readonly buildContext: (sessionId: string) => CommandContext;
  /** 命令前缀（默认 '/'）——解析器与提示文本共用 */
  readonly prefix?: string;
  /** 时钟注入（durationMs 计算；默认 Date.now，测试注入可控时钟） */
  readonly now?: () => number;
}

export class CommandRouter {
  private readonly registry: CommandRegistry;
  private readonly bus: EventBus;
  private readonly buildContext: (sessionId: string) => CommandContext;
  private readonly prefix: string;
  private readonly now: () => number;

  constructor(options: CommandRouterOptions) {
    this.registry = options.registry;
    this.bus = options.bus;
    this.buildContext = options.buildContext;
    this.prefix = options.prefix ?? '/';
    this.now = options.now ?? Date.now;
  }

  /**
   * 尝试把输入当作命令处理。
   *
   * @returns 命令结果（调用方渲染 text 即可）；**undefined = 不是命令**，
   *          调用方应把输入交给 SessionManager.runQuery 走模型对话。
   */
  async tryHandle(input: string, sessionId: string): Promise<CommandResult | undefined> {
    const parsed = parseCommand(input, this.prefix);
    if (parsed === undefined) return undefined; // 普通对话——不属于命令层

    const command = this.registry.get(parsed.name);
    if (command === undefined) {
      // 未知命令：不发事件（无真实调用），给用户修复提示
      const shown = parsed.name === '' ? '（空命令）' : `${this.prefix}${parsed.name}`;
      return {
        kind: 'text',
        text: `未知命令：${shown}。输入 ${this.prefix}help 查看全部命令。`,
      };
    }

    this.bus.emit({ type: 'command_invoked', command: command.name });
    const started = this.now();
    let ok = true;
    let text: string;
    try {
      const result = await command.run(this.buildContext(sessionId), parsed.args);
      text = result.text;
    } catch (raw) {
      // 控制面稳态（见文件头事件语义）——命令内部异常在这里兜底
      ok = false;
      const message = raw instanceof Error ? raw.message : String(raw);
      text = `命令 ${this.prefix}${command.name} 执行失败: ${message}`;
    }
    this.bus.emit({
      type: 'command_finished',
      command: command.name,
      ok,
      durationMs: this.now() - started,
    });
    return { kind: 'text', text };
  }
}
