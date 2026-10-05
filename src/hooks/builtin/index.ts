/**
 * 内置 hook 集合 —— 默认管道配置的唯一入口。
 *
 * 顺序即语义（priority 升序执行）：
 *   repeat-guard(40, pre)     → 先拦截重复调用（省掉后续一切工作）
 *   audit(10, post)           → 记录原始结果（在加工前）
 *   redact-result(20, post)   → 脱敏（结果即将进入上下文与持久化）
 *   truncate-result(30, post) → 截断（最后加工，避免先截断再脱敏漏检敏感片段）
 *
 * 注意 pre 与 post 是两个独立序列，priority 只在同阶段内比较。
 */

import type { Hook } from '../../types.ts';
import { createAuditHook } from './audit.ts';
import { createRedactResultHook } from './redact-result.ts';
import { createRepeatGuardHook } from './repeat-guard.ts';
import { createTruncateResultHook } from './truncate-result.ts';

export { createAuditHook, createRedactResultHook, createRepeatGuardHook, createTruncateResultHook };
export * from './shared.ts';

/** 默认 hook 集合的构造参数（对齐 config 的 hooks 域） */
export interface DefaultHooksOptions {
  /** 重复调用熔断阈值（config.hooks.repeatCallThreshold） */
  readonly repeatCallThreshold: number;
}

/**
 * 创建默认 hook 集合。
 * 每次调用返回全新实例——有状态的 hook（repeat-guard）因此天然获得
 * 「一个会话一套状态」的隔离（装配层每个会话调一次本函数）。
 */
export function createDefaultHooks(options: DefaultHooksOptions): Hook[] {
  return [
    createRepeatGuardHook({ threshold: options.repeatCallThreshold }),
    createAuditHook(),
    createRedactResultHook(),
    createTruncateResultHook(),
  ];
}
