/**
 * Session 模块出口。
 * 公开内容：
 *   - store.ts：SessionStore（SQLite 持久化 + 一致性模型）+ resolveStorePath；
 *   - checkpoint.ts：恢复语义的纯函数工具（pending 推导 / 中断补位）；
 *   - session-manager.ts：SessionManager（状态机 + query 编排 + 恢复流程）。
 *
 * 消费方：CLI（w17 组装）与集成测试；内核（kernel/）不反向依赖本模块——
 * 持久化经 LoopRunOptions.onTurnEnd 接缝注入（依赖倒置，见 agent-loop 决策 ⑥）。
 */

export * from './store.ts';
export * from './checkpoint.ts';
export * from './session-manager.ts';
