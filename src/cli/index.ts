/**
 * CLI 出口（w17）—— 供上层复用（lab 幕 I 与测试直接消费这里的导出）。
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 边界：main.ts 刻意不在出口内                                          │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * main.ts 是「副作用入口」（解析 argv、建 readline、注册信号、import 即执行）
 * ——入口职责不属于库 API 面；若被任何消费方误 import 会直接启动进程。
 * 需要「模拟入口行为」的场景（lab/测试）消费的应是 runOnce / startRepl
 * （壳逻辑）与 createCliApp（组装）——它们都不带进程副作用。
 */

export { createCliApp } from './app.ts';
export type { CliApp, CliAppOptions, CliOutput } from './app.ts';
export { createCliRenderer, formatResumeReport } from './render.ts';
export type { CliRenderer } from './render.ts';
export {
  createReadlineConfirm,
  describeError,
  runOnce,
  startRepl,
} from './repl.ts';
export type { ReplOptions } from './repl.ts';
export { createDemoProvider, createDemoRules, createSubagentDemoProvider } from './demo.ts';
export type { DemoProviderOptions } from './demo.ts';
