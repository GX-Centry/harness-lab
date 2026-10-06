/**
 * 环境体检入口（`pnpm preflight`）—— 问题 3 的「主动诊断」面。
 *
 * （命名说明：曾用名 doctor——被 pnpm 内置的 `pnpm doctor` 命令拦截，
 *  改用 preflight，与 src/preflight.ts 同名呼应。）
 *
 * 与启动预检（main.ts 内联）共用 src/preflight.ts 的同一套检查；差异只在
 * 展示策略：启动预检求「快」（error 阻断 / warn 一行 / ok 静默），本入口
 * 求「全」（完整报告 + 退出码——脚本与 CI 可判别）。
 *
 * import 约束（重要）：本脚本只依赖 src/preflight.ts——**不碰 store.ts**。
 * 效果：哪怕用户的 Node 太老（node:sqlite 不存在，主程序 import 阶段即崩），
 * 本脚本依然能运行，并给出「Node 版本过旧，请升级到 26+」的可读结论。
 */

import { formatPreflightReport, runPreflight } from '../src/preflight.ts';

const report = await runPreflight();

console.log('');
console.log(formatPreflightReport(report));
console.log('');

if (report.worst === 'error') {
  console.log('存在阻断级问题（error）——请先按 hint 处理，再启动 harness。');
  process.exit(1);
}
if (report.worst === 'warn') {
  console.log('存在提示级问题（warn）——不影响核心运行，建议按 hint 处理。');
}
