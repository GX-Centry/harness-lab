/**
 * 场景集运行入口 —— `pnpm scenarios` 的完整运行形态。
 *
 * 三段式（与 lab 幕 H 的「最小形态」对照）：
 *   1. runScenarios：串行跑完整场景集 → EvalReport；
 *   2. renderEvalReport：人读报告（通过 = 一行摘要；失败 = 完整原因清单）；
 *   3. reportExitCode：CI 退出码语义锚定（failed > 0 → 1）。
 *
 * run.ts 刻意保持「薄」：它不认识任何具体场景，只做入口编排——
 * 「场景即数据」的最后一段路：数据集 → 报告 → 进程契约。
 *
 * 若中文显示乱码：先执行 `chcp 65001` 或设置 PowerShell 输出编码为 UTF-8。
 */

import { renderEvalReport, reportExitCode, runScenarios } from '../src/eval/index.ts';
import { createFullScenarioSet } from './index.ts';

const scenarios = createFullScenarioSet();
const report = await runScenarios(scenarios);

console.log(`场景集冒烟：${scenarios.length} 个场景（内置基准 4 + 权限 / hook / 子代理 / 会话 8）`);
console.log(renderEvalReport(report));
process.exitCode = reportExitCode(report);
