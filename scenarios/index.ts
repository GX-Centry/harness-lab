/**
 * 完整场景集 —— 12 个场景的统一入口（内置基准 4 + 四域场景 8）。
 *
 * 分层结构（为什么这样分文件）：
 *   内置基准（src/eval/builtin-scenarios.ts）：最小形态的协议示例——
 *     随 eval 核心同行，任何消费方开箱可用；
 *   本目录（scenarios/）：完整场景集——按能力域分文件（permission /
 *     hooks / subagent / session），锚定「已实现模块行为」的端到端验证。
 *
 * 聚合顺序 = 运行顺序（runScenarios 串行保序）：内置在前（基线），
 * 四域随后（进阶能力）——报告可复现。
 *
 * 使用方式：
 *   - 命令行：pnpm scenarios（报告 + CI 退出码，见 run.ts）；
 *   - 编程式：runScenarios(createFullScenarioSet())；
 *   - 域内挑选：直接 import 某个 create*Scenarios（测试与调试用）。
 */

import { createBuiltinScenarios } from '../src/eval/index.ts';
import type { EvalScenario } from '../src/eval/index.ts';
import { createHookScenarios } from './hooks.ts';
import { createPermissionScenarios } from './permission.ts';
import { createSessionScenarios } from './session.ts';
import { createSubagentScenarios } from './subagent.ts';

export {
  createHookScenarios,
  createPermissionScenarios,
  createSessionScenarios,
  createSubagentScenarios,
};

/** 完整场景集：内置基准 4 + 权限 1 + hook 3 + 子代理 2 + 会话 2 = 12 */
export function createFullScenarioSet(): readonly EvalScenario[] {
  return [
    ...createBuiltinScenarios(),
    ...createPermissionScenarios(),
    ...createHookScenarios(),
    ...createSubagentScenarios(),
    ...createSessionScenarios(),
  ];
}
