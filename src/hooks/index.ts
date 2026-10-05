/**
 * Hook 层模块出口。
 * 公开内容：HookPipeline（执行语义与错误隔离）、内置 hook 集合。
 * Hook 协议（Hook / HookOutcome / HookPayload）定义在 src/types.ts。
 */

export * from './pipeline.ts';
export * from './builtin/index.ts';
