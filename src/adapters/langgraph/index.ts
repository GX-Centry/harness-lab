/**
 * adapters/langgraph 出口 —— 对照层（w16）。
 *
 * 刻意**不进** src/index.ts 主出口：主出口只导出「稳定协议」，而本层
 * 依赖可选包（@langchain/langgraph，devDependencies）——若从主出口导出，
 * 所有消费方都将被迫解析该依赖，违背「对照层是叶子、可整体删除」的
 * ADR 约定。消费方式：显式深导入 `harness-lab/src/adapters/langgraph/index.ts`。
 *
 *   - graph.ts  —— StateGraph 版 Loop（状态/节点/条件边 + 概念对照表）
 *   - runner.ts —— 与 AgentLoop 同契约的运行入口（LoopResult 同形）
 */

export { createLoopGraph } from './graph.ts';
export type { LoopGraph, LoopGraphDeps, LoopGraphState } from './graph.ts';
export { runLangGraphQuery } from './runner.ts';
export type { LangGraphRunnerOptions } from './runner.ts';
