/**
 * /skill —— 技能库浏览与执行（「控制面 → 确定性数据面」的桥）。
 *
 * ===========================================================================
 * 为什么技能执行要经过这个命令而不是直接被模型调用？
 * ===========================================================================
 * 与 /compact 同理（控制面 vs 数据面，见 types.ts 必答问题）：
 *   技能是用户定义的确定性流程——「什么时候跑」是用户的控制决策，
 *   不是模型的任务判断。v1 技能只从这里（或代码直调）触发。
 *
 *   演进点（skill-as-tool）：把技能包装成 Tool 暴露给模型后，模型可以
 *   「决定用某个技能」，但执行时仍走 SkillRunner → Dispatcher 同一条链——
 *   控制权分层：策略（何时用）归模型，流程（怎么走）归代码。
 *   包装层只需实现 Tool 接口、在 execute 里调 services.runner.run()，
 *   内核零改动——这正是「Agent-as-Tool」思想（w13 子代理同款）的预演。
 *
 * ---------------------------------------------------------------------------
 * 参数约定：/skill <name> [任意剩余文本]
 * ---------------------------------------------------------------------------
 *   剩余文本（rawArgs 的 name 之后部分）以 { text: "..." } 透传为技能 input——
 *   技能自己决定怎么解释（math-report 把它当作数学表达式）。
 *   这是「命令参数 → 技能 input → 步骤 args」参数链路的最小示范；
 *   更结构化的参数（键值对/JSON）属于命令层语法扩展，v1 不做。
 */

import type { SkillResult } from '../../skills/index.ts';
import type { CommandDefinition, CommandResult } from '../types.ts';

export const skillCommand: CommandDefinition = {
  name: 'skill',
  description: '列出技能，或执行一个技能（确定性编排，不经过模型）',
  usage: '/skill [name] [text]',

  async run(context, args): Promise<CommandResult> {
    // ---- 依赖缺省的显式降级 ----
    const services = context.skills;
    if (services === undefined) {
      return { kind: 'text', text: '未装配技能层（本装配不支持 /skill）。' };
    }

    // ---- 模式一：/skill —— 列出技能库 ----
    const [name, ...rest] = args;
    if (name === undefined) {
      const skills = services.registry.list();
      if (skills.length === 0) {
        return { kind: 'text', text: '技能库为空（未注册任何技能）。' };
      }
      const lines = skills.map((s) => `  ${s.name}（${s.steps.length} 步）  ${s.description}`);
      return {
        kind: 'text',
        text: [`可用技能（${skills.length} 个）:`, ...lines].join('\n'),
      };
    }

    // ---- 模式二：/skill <name> [text] —— 执行 ----
    const result = await services.runner.run(name, {
      sessionId: context.sessionId,
      workingDir: context.workingDir,
      input: { text: rest.join(' ') },
    });
    return { kind: 'text', text: renderResult(result) };
  },
};

/** SkillResult → 终端文本（成功=步骤流水账；失败=定位信息 + 已完成步骤） */
function renderResult(result: SkillResult): string {
  const stepLines = result.steps.map((step, index) => {
    const mark = step.ok ? '✓' : '✗';
    return `    ${index + 1}. ${mark} ${step.tool}: ${step.output}`;
  });

  if (result.ok) {
    return [
      `技能 ${result.skill} 执行成功（${result.steps.length} 步，${result.durationMs}ms）:`,
      ...stepLines,
    ].join('\n');
  }

  const lines = [`技能 ${result.skill} 执行失败（${result.reason}，${result.durationMs}ms）:`, `  ${result.message}`];
  if (stepLines.length > 0) {
    lines.push('  已执行的步骤:');
    lines.push(...stepLines);
  }
  return lines.join('\n');
}
