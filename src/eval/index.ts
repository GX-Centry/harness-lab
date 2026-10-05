/**
 * Eval 层出口 —— 最小评估闭环（场景 + 断言）。
 *
 * 使用方式（三种粒度，按需选择）：
 *   1. 全自动：  runScenarios(createBuiltinScenarios()) → EvalReport
 *                → renderEvalReport() 人读 / reportExitCode() 定 CI 退出码；
 *   2. 单场景：  runScenario(scenario) → ScenarioResult；
 *   3. 要证据：  createCoreRig / createSessionRig(scenario) → rig.run(input)
 *                → ScenarioEvidence（断言之外还要看账本/事件时用——lab 幕 H
 *                的演示路径；含会话预置的场景走 Session Rig，runner 自动分派）。
 *
 * 场景即数据：新场景 = 一个 EvalScenario 对象 + 一组行为断言（写法照抄
 * builtin-scenarios.ts；完整场景集见仓库根的 scenarios/）。eval 是横切
 * 消费层——依赖一切，不被一切依赖。
 */

export * from './types.ts';
export * from './assertions.ts';
export * from './rig.ts';
export * from './session-rig.ts';
export * from './runner.ts';
export * from './builtin-scenarios.ts';
