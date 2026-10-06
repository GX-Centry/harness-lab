/**
 * skills 模块出口。
 *
 * SkillServices：命令层（/skill）消费技能能力所需的**最小门面**——
 * 「列得出 + 跑得动」。用门面类型而非直接暴露两个类，是从命令层视角
 * 定义依赖（控制面只需要这两个动作；其余 API 变化不波及命令层）。
 */

import type { SkillRegistry } from './registry.ts';
import type { SkillRunner } from './runner.ts';

/** 命令层（/skill）消费的技能服务门面 */
export interface SkillServices {
  readonly registry: SkillRegistry;
  readonly runner: SkillRunner;
}

export * from './types.ts';
export { SkillRegistry } from './registry.ts';
export { SkillRunner } from './runner.ts';
export type { SkillRunnerOptions, SkillRunOptions } from './runner.ts';
export { skillToTool, skillToolName } from './tool-wrapper.ts';
export type { SkillToolOptions } from './tool-wrapper.ts';
export { mathReportSkill, createBuiltinSkills } from './builtin.ts';
