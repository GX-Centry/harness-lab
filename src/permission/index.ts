/**
 * Permission 层模块出口。
 * 公开内容：规则表与匹配、决策门禁（含确认交互抽象）、权限模式（三档姿态）。
 * PermissionDecision / PermissionMode 类型定义在 src/types.ts（全系统共享词汇）。
 */

export * from './rules.ts';
export * from './gate.ts';
export * from './modes.ts';
