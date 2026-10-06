/**
 * skill-as-tool 包装器（w18）—— 把 SkillDefinition 暴露为「模型可调用的 Tool」。
 *
 * ===========================================================================
 * 必答问题：为什么技能要「同时」存在于两个面（命令面 + 工具面）？
 * ===========================================================================
 * 接入真实 API 后暴露的关键断点：技能注册在 SkillRegistry 里，但**从未
 * 进入 ToolRegistry** —— 模型面（tools 参数）看不到任何技能。skills/types.ts
 * 与 commands/builtin/skill.ts 早就预留了这个演进点：
 *
 *   「把 Skill 包装成 Tool 暴露给模型（skill-as-tool）——模型决定『何时用』，
 *     Skill 保证『用的时候怎么走』。控制权分层：策略归模型，流程归代码。」
 *
 * 本文件就是那个包装层——与「Agent-as-Tool」（w13 子代理）同款思想：
 *   子代理 = 把一整个子循环包装成 Tool；
 *   技能   = 把一段确定性编排包装成 Tool。
 *
 * 两个面并存不冲突（各有消费者）：
 *   - 命令面（/skill）：用户显式控制——「我现在就要跑这个技能」；
 *   - 工具面（skill_<name>）：模型策略判断——「这个请求适合用技能完成」。
 *   两条路最终都收敛到 SkillRunner.run() → Dispatcher 同一条四步链——
 *   技能执行永远不会绕过权限/hook/审计（runner.ts 决策①）。
 *
 * ---------------------------------------------------------------------------
 * 关键设计决策（逐条标注理由）
 * ---------------------------------------------------------------------------
 *
 * 决策①：包装工具 risk = 'low'，权限边界在「每一步」而不是「入口」。
 *   技能本身不增加任何新能力——它的每个步骤都要经过 Dispatcher 的权限
 *   检查（高风险步骤照常 confirm/deny）。如果把包装工具标成 high，会在
 *   入口先拦一道、步骤再拦一道——同一个动作双重确认，且入口的确认信息
 *   还是模糊的（「要不要跑这个技能」vs「要不要写这个文件」）。
 *   注：semi/auto 模式下 low 的自动放行只影响「入口」，步骤级检查照旧——
 *   这正是「包装层不越权」的含义。
 *
 * 决策②：工具超时 = 单步预算 × 步骤数 + 余量（而非全局默认值）。
 *   技能是「多步串行」，用单工具的 30s 预算会把它误杀在中途；申报自己的
 *   预算 = 工具作者最清楚自己该跑多久（与子代理工具同一约定，见 types.ts
 *   Tool.timeoutMs 注释）。
 *
 * 决策③：失败映射走「失败步骤的原始 ToolResult.error.code」。
 *   技能失败的根因大多来自某一步的工具失败（权限拒绝/超时/参数错）；
 *   把该步的原始错误码透传给模型，模型才能做正确的自我修正（permission
 *   →换路；input →改参数）。run_error（技能自身声明错误）映射为
 *   internal_error——模型改不了，但应知道这不是它的锅。
 *
 * 依赖方向：skills/tool-wrapper.ts → types.ts / errors.ts / ./types.ts / ./runner.ts。
 */

import { z } from 'zod';
import type { ToolErrorCode } from '../errors.ts';
import type { Tool, ToolResult } from '../types.ts';
import { okResult } from '../types.ts';
import type { SkillRunner } from './runner.ts';
import type { SkillDefinition, SkillResult, SkillRunFailure_ } from './types.ts';

// ===========================================================================
// §1 命名与选项
// ===========================================================================

/**
 * 技能 → 模型可见工具名（skill_ 前缀 + 字符规范化）。
 * 前缀是刻意的：system prompt / 日志 / 观察面板都能一眼区分「技能工具」
 * 与普通工具；规范化保证名字符合 OpenAI 工具名协议（^[a-zA-Z0-9_-]+$）。
 * 导出给 system-prompt 装配层复用——名字规则只有这一处定义。
 */
export function skillToolName(skillName: string): string {
  return `skill_${skillName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

export interface SkillToolOptions {
  /**
   * 单步超时预算（毫秒）——总超时 = perStepTimeoutMs × 步骤数 + overheadMs。
   * 缺省时不申报 timeoutMs（Dispatcher 用全局默认值兜底）——最小装配场景。
   */
  readonly perStepTimeoutMs?: number;
  /** 总超时的固定余量（步骤调度/事件/prompt 开销；缺省 5000ms） */
  readonly overheadMs?: number;
}

const DEFAULT_OVERHEAD_MS = 5_000;

// ===========================================================================
// §2 包装实现
// ===========================================================================

/** 模型可见的输入：单个自由文本（映射为技能 input.text——与 /skill 命令同一约定） */
interface SkillToolInput {
  readonly input?: string;
}

/**
 * 把技能包装成 Tool。
 *
 * @param skill  技能声明（决定工具名/描述/超时预算）
 * @param runner 技能执行器（execute 的唯一依赖——执行链收敛点）
 */
export function skillToTool(
  skill: SkillDefinition,
  runner: SkillRunner,
  options: SkillToolOptions = {},
): Tool<SkillToolInput> {
  const perStep = options.perStepTimeoutMs;
  const timeoutMs =
    perStep === undefined ? undefined : perStep * skill.steps.length + (options.overheadMs ?? DEFAULT_OVERHEAD_MS);

  return {
    name: skillToolName(skill.name),
    description: `技能「${skill.name}」：${skill.description}。确定性步骤序列（${skill.steps.length} 步）——适合此技能覆盖的任务优先用它，而不是逐步手动调用工具。`,
    inputSchema: z.object({
      input: z
        .string()
        .optional()
        .describe('传给技能的输入文本（技能自行解释；缺省时技能使用自己的默认输入）'),
    }),
    risk: 'low', // 决策①：入口不限权——各步骤在 Dispatcher 里逐一体检
    ...(timeoutMs === undefined ? {} : { timeoutMs }), // 决策②：总预算按步骤数放大

    async execute(input, ctx): Promise<ToolResult> {
      const result = await runner.run(skill.name, {
        sessionId: ctx.sessionId,
        workingDir: ctx.workingDir,
        input: { text: input.input ?? '' },
        signal: ctx.signal,
        // AbortError 从 runner 穿透（决策④ of runner.ts）→ Dispatcher 同样穿透
        // → Loop 收敛为取消。包装层不做任何异常转换。
      });
      return result.ok ? renderSuccess(result) : renderFailure(result);
    },
  };
}

/** 成功：把步骤流水账压成模型可读的文本（模型主要消费「最后一步的输出」） */
function renderSuccess(result: SkillResult & { ok: true }): ToolResult {
  const stepLines = result.steps.map((step, index) => `${index + 1}. ${step.tool}: ${step.output}`);
  return okResult(
    [
      `技能 "${result.skill}" 执行成功（${result.steps.length} 步，${result.durationMs}ms）:`,
      ...stepLines,
    ].join('\n'),
    { skill: result.skill, steps: result.steps.length, durationMs: result.durationMs },
  );
}

/**
 * 失败：结构化失败 → 给模型的失败结果（错误码透传失败步骤的原始错误码——决策③）。
 * content 包含失败定位与「怎么改」的提示；error.message 是精确描述（给日志）。
 */
function renderFailure(result: SkillRunFailure_): ToolResult {
  const stepLines = result.steps.map((step, index) => {
    const mark = step.ok ? '✓' : '✗';
    return `  ${index + 1}. ${mark} ${step.tool}: ${step.output}`;
  });
  const lines = [`技能 "${result.skill}" 执行失败（${result.reason}）: ${result.message}`];
  if (stepLines.length > 0) lines.push('步骤流水:', ...stepLines, '可改用逐个工具调用的方式完成同样的任务。');

  const code = failureCode(result);
  return {
    ok: false,
    content: lines.join('\n'),
    error: { code, message: `技能 "${result.skill}" 失败（${result.reason}）: ${result.message}` },
  };
}

/** 错误码映射：优先透传失败步骤的原始 ToolErrorCode（决策③） */
function failureCode(result: SkillRunFailure_): ToolErrorCode {
  if (result.reason === 'step_failed') {
    const failedStep = result.steps[result.failedAt ?? result.steps.length - 1];
    if (failedStep !== undefined && !failedStep.raw.ok) {
      return failedStep.raw.error.code;
    }
    return 'service_error'; // 理论不可达（step_failed 必带失败步骤）——防御性兜底
  }
  // unknown_skill / unknown_tool / run_error：技能声明或执行器问题，模型无法修正
  return 'internal_error';
}
