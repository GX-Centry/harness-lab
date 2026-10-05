/**
 * subagent 模块出口。
 *
 * 对外形态：
 *   - 类型层（types.ts）：定义 / 任务 / 报告 / 依赖形状；
 *   - 工具层（agent-tool.ts）：createAgentTool（单个）+ registerAgentTools（批量注册）；
 *   - 编排层（orchestrator.ts）：runSubagents（编程式 fan-out）
 *     + createOrchestratorTool（模型驱动 spawn）；
 *   - 引擎层（pool.ts）：runWithConcurrency（通用有界并发——与领域无关，
 *     单独导出供任何「并发任务列表」场景复用）。
 */

export * from './types.ts';
export { createAgentTool, compileAgentTools, registerAgentTools } from './agent-tool.ts';
export type { CompiledAgentTools } from './agent-tool.ts';
export { runWithConcurrency } from './pool.ts';
export type { PoolOutcome, PoolOptions, PoolTaskFn } from './pool.ts';
export { runSubagents, createOrchestratorTool } from './orchestrator.ts';
export type { OrchestratorContext, OrchestratorToolOptions, RunSubagentsOptions } from './orchestrator.ts';
