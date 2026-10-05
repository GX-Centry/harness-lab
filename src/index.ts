/**
 * harness-lab 库出口 —— public API 汇总。
 *
 * 约定：
 *   - 只导出「稳定协议」：类型与工厂函数、配置、错误体系、EventBus；
 *   - 各模块实现完成后（如 kernel/agent-loop），在此追加对应导出；
 *   - 消费方一律从本文件消费，禁止深路径导入（'harness-lab/src/llm/...'）——
 *     API 面收敛在一个文件，才能做版本管理与「哪些是公共契约」的清晰划界。
 *
 * 注：`export *` 会同时携带类型与运行时成员；本项目 types.ts 刻意
 * 「类型 + 工厂函数」混排在同一文件（形状与构造相邻），所以不需要 `export type *`。
 */

export * from './errors.ts';
export * from './types.ts';
export * from './config.ts';
export * from './kernel/index.ts';
export * from './llm/index.ts';
export * from './tools/index.ts';
export * from './hooks/index.ts';
export * from './permission/index.ts';
export * from './context/index.ts';
export * from './session/index.ts';
export * from './memory/index.ts';
export * from './skills/index.ts';
export * from './commands/index.ts';
export * from './subagent/index.ts';
export * from './observability/index.ts';
export * from './eval/index.ts';
// 预留模块（ADR-010）：只有接口与注释，零实现——可整体删除（含此行）
export * from './placeholders/index.ts';
