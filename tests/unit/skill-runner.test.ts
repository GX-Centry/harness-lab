/**
 * SkillRunner 单元测试 —— 确定性执行器的行为矩阵。
 *
 * 覆盖矩阵（对齐 runner.ts 文件头的五条设计决策）：
 *   ① 成功路径：全步骤走 Dispatcher（不绕过四步链）；数据流正确传递；
 *   ② fail-fast：工具失败后后续步骤零执行；
 *   ③ 预检：未知工具在执行前暴露（零副作用）；
 *   ④ 边界转换：resolveArgs 异常 → run_error；AbortError 穿透传播；
 *   ⑤ 事件边界：skill_started → tool_* → skill_finished 的顺序与 ok 值。
 */

import { describe, expect, it } from 'vitest';
import { defineConfig } from '../../src/config.ts';
import { HookPipeline } from '../../src/hooks/pipeline.ts';
import { Dispatcher } from '../../src/kernel/dispatcher.ts';
import type { HarnessEvent } from '../../src/kernel/events.ts';
import { EventBus } from '../../src/kernel/events.ts';
import { PermissionGate } from '../../src/permission/gate.ts';
import { SkillRegistry } from '../../src/skills/registry.ts';
import { SkillRunner } from '../../src/skills/runner.ts';
import type { SkillDefinition } from '../../src/skills/types.ts';
import { createBuiltinSkills } from '../../src/skills/builtin.ts';
import { createBuiltinTools } from '../../src/tools/builtin/index.ts';
import { ToolRegistry } from '../../src/tools/registry.ts';

// ---------------------------------------------------------------------------
// 测试装置（真实 Dispatcher 全链路——技能不允许绕过它，测试也不该绕过）
// ---------------------------------------------------------------------------

interface RunnerFixture {
  readonly runner: SkillRunner;
  readonly events: HarnessEvent[];
}

function makeFixture(extraSkills: readonly SkillDefinition[] = []): RunnerFixture {
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

const RUN = { sessionId: 'skill-test', workingDir: process.cwd() } as const;

/** 工具执行次数（经 Dispatcher 的证据） */
function toolRuns(events: readonly HarnessEvent[]): number {
  return events.filter((event) => event.type === 'tool_call_assembled').length;
}

// ---------------------------------------------------------------------------
// ① 成功路径与数据流
// ---------------------------------------------------------------------------

describe('SkillRunner：成功路径', () => {
  it('两步全部经 Dispatcher 执行，返回成功与步骤结果', async () => {
    const f = makeFixture();
    const result = await f.runner.run('math-report', { ...RUN, input: { text: '21 * 2' } });

    expect(result.ok).toBe(true);
    if (!result.ok) return; // 类型收窄（失败时上面的断言已挂）
    expect(result.steps.map((s) => s.tool)).toEqual(['calculator', 'echo']);
    expect(result.steps.every((s) => s.ok)).toBe(true);
    expect(result.steps[0]?.output).toContain('= 42');
    expect(result.steps[1]?.output).toContain('【计算报告】');
    expect(toolRuns(f.events)).toBe(2); // 技能没有绕过 Dispatcher
  });

  it('数据流：第二步输出包含第一步输出（output 文本通道）', async () => {
    const f = makeFixture();
    const result = await f.runner.run('math-report', { ...RUN, input: { text: '(1+2)*3.5' } });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [first, second] = result.steps;
    expect(first?.output).toBe('表达式 (1+2)*3.5 = 10.5');
    expect(second?.output).toContain(first?.output ?? '');
  });

  it('缺省输入时回退默认表达式（技能永远可跑）', async () => {
    const f = makeFixture();
    const result = await f.runner.run('math-report', RUN);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.steps[0]?.output).toContain('1 + 1 = 2');
  });

  it('第一步看到的 results 为空快照', async () => {
    let observedLength = -1;
    const snapshotSkill: SkillDefinition = {
      name: 'snapshot-probe',
      description: '探测第一步收到的 results',
      steps: [
        {
          tool: 'echo',
          describe: '记录 results 长度',
          resolveArgs: (ctx) => {
            observedLength = ctx.results.length;
            return { message: 'ok' };
          },
        },
      ],
    };
    const f = makeFixture([snapshotSkill]);
    await f.runner.run('snapshot-probe', RUN);
    expect(observedLength).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ② fail-fast
// ---------------------------------------------------------------------------

describe('SkillRunner：fail-fast', () => {
  it('工具失败后终止：后续步骤零执行，failedAt 定位失败步骤', async () => {
    const failingSkill: SkillDefinition = {
      name: 'failing',
      description: '第 2 步必败（除零）',
      steps: [
        { tool: 'echo', describe: '第 1 步成功', resolveArgs: () => ({ message: 'ok-1' }) },
        { tool: 'calculator', describe: '第 2 步除零失败', resolveArgs: () => ({ expression: '1 / 0' }) },
        { tool: 'echo', describe: '第 3 步不应执行', resolveArgs: () => ({ message: 'never' }) },
      ],
    };
    const f = makeFixture([failingSkill]);
    const result = await f.runner.run('failing', RUN);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('step_failed');
    expect(result.failedAt).toBe(1);
    expect(result.steps).toHaveLength(2); // 第 3 步没有产出
    expect(result.steps[1]?.ok).toBe(false);
    expect(toolRuns(f.events)).toBe(2); // Dispatcher 只被调了 2 次
  });
});

// ---------------------------------------------------------------------------
// ③ 预检（未知技能 / 未知工具）
// ---------------------------------------------------------------------------

describe('SkillRunner：预检', () => {
  it('未知技能：结构化失败并列出可用技能', async () => {
    const f = makeFixture();
    const result = await f.runner.run('no-such-skill', RUN);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknown_skill');
    expect(result.steps).toHaveLength(0);
    expect(result.message).toContain('math-report');
  });

  it('未知工具：执行前整体预检（零副作用——第一步也不执行）', async () => {
    const badToolSkill: SkillDefinition = {
      name: 'bad-tool',
      description: '第 2 步引用未注册工具',
      steps: [
        { tool: 'echo', describe: '合法步骤', resolveArgs: () => ({ message: 'x' }) },
        { tool: 'no-such-tool', describe: '非法引用', resolveArgs: () => ({}) },
      ],
    };
    const f = makeFixture([badToolSkill]);
    const result = await f.runner.run('bad-tool', RUN);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknown_tool');
    expect(result.message).toContain('no-such-tool');
    expect(toolRuns(f.events)).toBe(0); // 预检失败 → 一步都没跑
  });
});

// ---------------------------------------------------------------------------
// ④ 异常边界
// ---------------------------------------------------------------------------

describe('SkillRunner：异常边界', () => {
  it('resolveArgs 抛异常 → run_error（不穿透）', async () => {
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
    const result = await f.runner.run('throwing', RUN);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('run_error');
    expect(result.failedAt).toBe(0);
    expect(result.message).toContain('参数构造炸了');
  });

  it('AbortError 穿透传播（取消不是失败，不做结果转换）', async () => {
    const f = makeFixture();
    const controller = new AbortController();
    controller.abort();

    let caught: unknown;
    try {
      await f.runner.run('math-report', { ...RUN, signal: controller.signal });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DOMException);
    expect((caught as DOMException).name).toBe('AbortError');
  });
});

// ---------------------------------------------------------------------------
// ⑤ 事件边界
// ---------------------------------------------------------------------------

describe('SkillRunner：事件边界', () => {
  it('成功：skill_started 在前、skill_finished(ok=true) 在最后', async () => {
    const f = makeFixture();
    await f.runner.run('math-report', { ...RUN, input: { text: '1 + 1' } });

    const types = f.events.map((event) => event.type);
    expect(types[0]).toBe('skill_started');
    expect(types[types.length - 1]).toBe('skill_finished');
    const finished = f.events.find((event) => event.type === 'skill_finished');
    expect(finished?.type === 'skill_finished' && finished.ok).toBe(true);
    expect(typeof (finished?.type === 'skill_finished' ? finished.durationMs : undefined)).toBe(
      'number',
    );
  });

  it('失败：skill_finished(ok=false) 仍然发射', async () => {
    const failingSkill: SkillDefinition = {
      name: 'fail-fast',
      description: '立即失败',
      steps: [
        { tool: 'calculator', describe: '除零', resolveArgs: () => ({ expression: '5 / 0' }) },
      ],
    };
    const f = makeFixture([failingSkill]);
    await f.runner.run('fail-fast', RUN);

    const finished = f.events.find((event) => event.type === 'skill_finished');
    expect(finished?.type === 'skill_finished' && finished.ok).toBe(false);
  });
});
