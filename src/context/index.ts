/**
 * Context 模块出口。
 * 公开内容：
 *   - tokens.ts：TokenCounter 与消息级计量（预算是硬约束，计量是第一公民）；
 *   - compressor.ts：压缩链工具（L1 截断 / L2 占位 / L3 规则摘要 / L4 保底）；
 *   - manager.ts：ContextManager 主入口（build 一次组装）；
 *   - system-prompt.ts：System Prompt 构建器（工具面/技能面向模型暴露的载体）。
 *
 * 消费方：kernel/agent-loop（每轮组装请求前调用 build）；cli/app（装配期构建 prompt）。
 */

export * from './tokens.ts';
export * from './compressor.ts';
export * from './manager.ts';
export * from './system-prompt.ts';
