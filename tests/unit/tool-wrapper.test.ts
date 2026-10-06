/**
 * skill-as-tool 包装器单元测试 —— 「技能进入模型面」的协议验证。
 *
 * 背景（w18）：接入真实 API 后暴露的关键断点——技能只注册在 SkillRegistry，
 * 模型面（tools 参数）看不到。本测试锁定包装层的全部对外承诺：
 *
 * 覆盖矩阵（对齐 tool-wrapper.ts 的三条设计决策）：
 *   ① 命名与声明：skill_ 前缀 + 字符规范化；risk=low（决策①：入口不限权）；
 *      超时预算 = 单步 × 步骤数 + 余量（决策②）；
 *   ② 输入映射：input.input 文本 → 技能 input.text（缺省时技能自回退默认）；
 *   ③ 成功渲染：步骤流水 + 结构化 meta（skill / steps / durationMs）；
 *   ④ 失败映射：step_failed 透传失败步骤原始错误码（决策③）；
 *      unknown_skill / run_error → internal_error；AbortError 原样穿透；
 *   ⑤ 链路证据：包装工具执行产生 skill_started → tool_call_assembled×N
 *      → skill_finished（技能没有绕过 Dispatcher——与 /skill 命令同链）。
 */

import { describe, expect, it } from 'vitest';
import { defineConfig } from '../../src/config.ts';
import { HookPipeline } from '../../src/hooks/pipeline.ts';
import { Dispatcher } from '../../src/kernel/dispatcher.ts';
import type { HarnessEvent } from '../../src/kernel/events.ts';
import { EventBus } from '../../src/kernel/events.ts';
import { PermissionGate } from '../../src/permission/gate.ts';
import { createBuiltinSkills } from '../../src/skills/builtin.ts';
import { SkillRegistry } from '../../src/skills/registry.ts';
import { SkillRunner } from '../../src/skills/runner.ts';
import { skillToTool, skillToolName } from '../../src/skills/tool-wrapper.ts';
import type { SkillDefinition } from '../../src/skills/types.ts';
import { createBuiltinTools } from '../../src/tools/builtin/index.ts';
import { ToolRegistry } from '../../src/tools/registry.ts';
import type { ToolContext } from '../../src/types.ts';

// ---------------------------------------------------------------------------
// 测试装置（真实 Dispatcher 全链路——包装层不允许绕过它，测试也不该绕过）
// ---------------------------------------------------------------------------

interface WrapperFixture {
  readonly runner: SkillRunner;
  readonly events: HarnessEvent[];
}

function makeFixture(extraSkills: readonly SkillDefinition[] = []): WrapperFixture {
  const config = defineConfig();
  let tick = 1_700_000_000_000;
  const clock = (): number => (tick += 1);

  const tools = new ToolRegistry();
  for (const tool of createBuiltinTools()) tools.register(tool);

  const bus = new EventBus();
  const events: HarnessEvent[] = [];
  bus.on('*', (event) => events.push(event));

  const hooks = new HookPipeline({ hooks: [], bus });
  const permission = new PermissionGate({ config: config.permission });
  const dispatcher = new Dispatcher({ registry: tools, hooks, permission, bus, config });

  const registry = new SkillRegistry();
  for (const skill of [...createBuiltinSkills(), ...extraSkills]) registry.register(skill);

  const runner = new SkillRunner({ registry, tools, dispatcher, bus, now: clock });
  return { runner, events };
}

/** 工具执行上下文（Dispatcher 之外直接驱动 execute 时的最小 ctx） */
function mkCtx(signal?: AbortSignal): ToolContext {
  return {
    sessionId: 'wrapper-test',
    queryId: 'wrapper-test-q1',
    workingDir: process.cwd(),
    signal: signal ?? new AbortController().signal,
  };
}

function toolRuns(events: readonly HarnessEvent[]): number {
  return events.filter((event) => event.type === 'tool_call_assembled').length;
}

/** 内置技能 math-report（断言基准） */
function mathReport(): SkillDefinition {
  const skill = createBuiltinSkills().find((candidate) => candidate.name === 'math-report');
  if (skill === undefined) throw new Error('内置技能 math-report 缺失');
  return skill;
}

// ---------------------------------------------------------------------------
// ① 命名与声明
// ---------------------------------------------------------------------------

describe('skill-as-tool：命名与声明', () => {
  it('skillToolName：skill_ 前缀；非协议字符规范化为下划线', () => {
    expect(skillToolName('math-report')).toBe('skill_math-report');
    expect(skillToolName('a b/c.d')).toBe('skill_a_b_c_d');
  });

  it('工具声明：名字 / 低风险入口 / 描述含步数（决策①）', () => {
    const f = makeFixture();
    const skill = mathReport();
    const tool = skillToTool(skill, f.runner);

    expect(tool.name).toBe('skill_math-report');
    expect(tool.risk).toBe('low'); // 决策①：权限边界在每一步，不在入口
    expect(tool.description).toContain('math-report');
    expect(tool.description).toContain(`${skill.steps.length} 步`);
  });

  it('超时预算：缺省不申报；perStepTimeoutMs 时 = 单步 × 步骤数 + 余量（决策②）', () => {
    const f = makeFixture();
    const skill = mathReport();

    const bare = skillToTool(skill, f.runner);
    expect(bare.timeoutMs).toBeUndefined();

    const budgeted = skillToTool(skill, f.runner, { perStepTimeoutMs: 1_000 });
    expect(budgeted.timeoutMs).toBe(1_000 * skill.steps.length + 5_000);

    const custom = skillToTool(skill, f.runner, { perStepTimeoutMs: 1_000, overheadMs: 123 });
    expect(custom.timeoutMs).toBe(1_000 * skill.steps.length + 123);
  });
});

// ---------------------------------------------------------------------------
// ② 输入映射 + ③ 成功渲染
// ---------------------------------------------------------------------------

describe('skill-as-tool：成功路径', () => {
  it('input.input 透传为技能 input.text：输出含计算结果与步骤流水', async () => {
    const f = makeFixture();
    const tool = skillToTool(mathReport(), f.runner);

    const result = await tool.execute({ input: '21 * 2' }, mkCtx());

    expect(result.ok).toBe(true);
    expect(result.content).toContain('技能 "math-report" 执行成功');
    expect(result.content).toContain('1. calculator:');
    expect(result.content).toContain('2. echo:');
    expect(result.content).toContain('表达式 21 * 2 = 42');
  });

  it('成功 meta：结构化通道（skill / 步数 / 时长）', async () => {
    const f = makeFixture();
    const tool = skillToTool(mathReport(), f.runner);

    const result = await tool.execute({ input: '1 + 2' }, mkCtx());

    expect(result.meta?.['skill']).toBe('math-report');
    expect(result.meta?.['steps']).toBe(2);
    expect(typeof result.meta?.['durationMs']).toBe('number');
  });

  it('缺省 input（undefined）：技能回退默认表达式，包装层不干预', async () => {
    const f = makeFixture();
    const tool = skillToTool(mathReport(), f.runner);

    const result = await tool.execute({}, mkCtx());

    expect(result.ok).toBe(true);
    expect(result.content).toContain('1 + 1 = 2');
  });

  it('链路证据：走完整 Dispatcher 四步链（skill_started → 2 次工具 → skill_finished）', async () => {
    const f = makeFixture();
    const tool = skillToTool(mathReport(), f.runner);

    await tool.execute({ input: '3 * 4' }, mkCtx());

    const types = f.events.map((event) => event.type);
    expect(types[0]).toBe('skill_started');
    expect(types[types.length - 1]).toBe('skill_finished');
    expect(toolRuns(f.events)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// ④ 失败映射
// ---------------------------------------------------------------------------

describe('skill-as-tool：失败映射', () => {
  it('step_failed：透传失败步骤的原始错误码（决策③——模型可据此自我修正）', async () => {
    const failingSkill: SkillDefinition = {
      name: 'divide-fail',
      description: '第 2 步除零失败',
      steps: [
        { tool: 'echo', describe: '第 1 步成功', resolveArgs: () => ({ message: 'ok' }) },
        { tool: 'calculator', describe: '第 2 步除零', resolveArgs: () => ({ expression: '1 / 0' }) },
      ],
    };
    const f = makeFixture([failingSkill]);
    const tool = skillToTool(failingSkill, f.runner);

    const result = await tool.execute({ input: 'ignored' }, mkCtx());

    expect(result.ok).toBe(false);
    if (result.ok) return; // 类型收窄（失败时上面的断言已挂）
    expect(result.error.code).toBe('input_error'); // calculator 除零的原始码
    expect(result.content).toContain('执行失败');
    expect(result.content).toContain('步骤流水');
    expect(result.content).toContain('可改用逐个工具调用');
  });

  it('unknown_skill：模型面看到的是 internal_error（技能注册表问题，非模型可修正）', async () => {
    const ghostSkill: SkillDefinition = {
      name: 'ghost',
      description: '未注册到 runner 的技能',
      steps: [{ tool: 'echo', describe: '任意步骤', resolveArgs: () => ({ message: 'x' }) }],
    };
    const f = makeFixture(); // 刻意不注册 ghost
    const tool = skillToTool(ghostSkill, f.runner);

    const result = await tool.execute({ input: 'x' }, mkCtx());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('internal_error');
    expect(result.content).toContain('unknown_skill');
  });

  it('run_error（resolveArgs 抛错）：同样映射为 internal_error', async () => {
    const throwingSkill: SkillDefinition = {
      name: 'throwing',
      description: '参数构造必炸',
      steps: [
        {
          tool: 'echo',
          describe: 'resolveArgs 抛错',
          resolveArgs: () => {
            throw new Error('参数构造炸了');
          },
        },
      ],
    };
    const f = makeFixture([throwingSkill]);
    const tool = skillToTool(throwingSkill, f.runner);

    const result = await tool.execute({ input: 'x' }, mkCtx());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('internal_error');
  });

  it('AbortError 原样穿透（取消不是失败——包装层不做任何异常转换）', async () => {
    const f = makeFixture();
    const tool = skillToTool(mathReport(), f.runner);
    const controller = new AbortController();
    controller.abort();

    let caught: unknown;
    try {
      await tool.execute({ input: '21 * 2' }, mkCtx(controller.signal));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DOMException);
    expect((caught as DOMException).name).toBe('AbortError');
  });
});
