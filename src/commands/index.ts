/**
 * commands 模块出口 —— 命令层「控制面」。
 *
 * 使用姿势（REPL 消费循环，CLI w17 与 lab 幕 F 同款）：
 *
 *   const handled = await router.tryHandle(input, sessionId);
 *   if (handled !== undefined) {
 *     console.log(handled.text);          // 命令路径：不进模型
 *   } else {
 *     for await (const ev of manager.runQuery(...)) { ... }  // 对话路径
 *   }
 */

export * from './types.ts';
export { parseCommand } from './parser.ts';
export type { ParsedCommand } from './parser.ts';
export { CommandRegistry } from './registry.ts';
export { CommandRouter } from './router.ts';
export type { CommandRouterOptions } from './router.ts';
export { createBuiltinCommands } from './builtin/index.ts';
