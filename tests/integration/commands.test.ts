/**
 * 命令层集成测试 —— router + 五个内置命令的端到端验证。
 *
 * 装配完整性（与本项目其它集成测试同款「全真链路」）：
 *   ToolRegistry → Dispatcher → FakeProvider → ContextManager → AgentLoop
 *   → SessionStore(:memory:) → SessionManager → SkillRegistry/SkillRunner
 *   → CommandRegistry → CommandRouter
 *
 * 覆盖矩阵：
 *   ① 拦截语义：普通输入不属于命令层（返回 undefined，交给 LLM 路径）；
 *   ② 五个内置命令的输出正确性（/help /status /history /compact /skill）；
 *   ③ 边界与降级：参数非法、未知命令、空命令、依赖未装配；
 *   ④ 控制面稳态：命令内部异常被兜底为失败文本 + ok=false 事件；
 *   ⑤ 硬证据：执行命令不产生任何 LLM 请求（「命令不进模型」的终极断言）。
 */

import { describe, expect, it } from 'vitest';
import { createBuiltinCommands } from '../../src/commands/builtin/index.ts';
import { CommandRegistry } from '../../src/commands/registry.ts';
import { CommandRouter } from '../../src/commands/router.ts';
import type { CommandContext } from '../../src/commands/types.ts';
import { defineConfig } from '../../src/config.ts';
import type { DeepPartial, HarnessConfig } from '../../src/config.ts';
import { ContextManager } from '../../src/context/manager.ts';
import { HookPipeline } from '../../src/hooks/pipeline.ts';
import { AgentLoop } from '../../src/kernel/agent-loop.ts';
import { Dispatcher } from '../../src/kernel/dispatcher.ts';
import type { HarnessEvent } from '../../src/kernel/events.ts';
import { EventBus } from '../../src/kernel/events.ts';
import { FakeProvider } from '../../src/llm/fake-provider.ts';
import type { FakeTurn } from '../../src/llm/fake-provider.ts';
import { PermissionGate } from '../../src/permission/gate.ts';
import { SessionManager } from '../../src/session/session-manager.ts';
import { SessionStore } from '../../src/session/store.ts';
import { createBuiltinSkills } from '../../src/skills/builtin.ts';
import { SkillRegistry } from '../../src/skills/registry.ts';
import { SkillRunner } from '../../src/skills/runner.ts';
import { createBuiltinTools } from '../../src/tools/builtin/index.ts';
import { ToolRegistry } from '../../src/tools/registry.ts';

// ---------------------------------------------------------------------------
// 测试装置：完整「REPL」装配
// ---------------------------------------------------------------------------

interface CmdFixture {
  readonly router: CommandRouter;
  readonly registry: CommandRegistry;
  readonly manager: SessionManager;
  readonly store: SessionStore;
  readonly provider: FakeProvider;
  readonly events: HarnessEvent[];
  /** 命令路径：返回文本；undefined = 不是命令（应走 LLM） */
  handle(sessionId: string, input: string): Promise<string | undefined>;
  /** 对话路径：消费一轮完整 query（事件已由 bus 收集） */
  run(sessionId: string, input: string): Promise<void>;
}

interface FixtureOptions {
  readonly script?: readonly FakeTurn[];
  readonly overrides?: DeepPartial<HarnessConfig>;
  /** 模拟「最小装配」：不接技能层（/skill 应给出降级提示） */
  readonly withoutSkills?: boolean;
}

function makeFixture(options: FixtureOptions = {}): CmdFixture {
  const config = defineConfig(options.overrides ?? {});
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

  const provider = new FakeProvider({ script: options.script ?? [] });
  const contextManager = new ContextManager({
    config: config.context,
    count: (text) => provider.countTokens(text),
    bus,
  });
  const loop = new AgentLoop({
    provider,
    dispatcher,
    registry: tools,
    bus,
    config,
    contextManager,
    systemPrompt: '测试 system',
  });
  const store = new SessionStore(':memory:', { now: clock });
  const manager = new SessionManager({ store, loop, bus, config, workingDir: process.cwd() });

  const skillRegistry = new SkillRegistry();
  for (const skill of createBuiltinSkills()) skillRegistry.register(skill);
  const skillRunner = new SkillRunner({
    registry: skillRegistry,
    tools,
    dispatcher,
    bus,
    now: clock,
  });
  const skills =
    options.withoutSkills === true ? undefined : { registry: skillRegistry, runner: skillRunner };

  const registry = new CommandRegistry();
  for (const command of createBuiltinCommands(registry)) registry.register(command);

  const buildContext = (sessionId: string): CommandContext => ({
    sessionId,
    manager,
    store,
    contextManager,
    skills,
    workingDir: process.cwd(),
    bus,
    config,
  });
  const router = new CommandRouter({ registry, bus, buildContext, now: clock });

  const handle = async (sessionId: string, input: string): Promise<string | undefined> => {
    const result = await router.tryHandle(input, sessionId);
    return result?.text;
  };
  const run = async (sessionId: string, input: string): Promise<void> => {
    const controller = new AbortController();
    for await (const event of manager.runQuery(sessionId, input, controller.signal)) {
      void event; // 只需消费完毕（事件已由 bus 收集）
    }
  };
  return { router, registry, manager, store, provider, events, handle, run };
}

// ---------------------------------------------------------------------------
// ① 拦截语义
// ---------------------------------------------------------------------------

describe('CommandRouter：拦截语义', () => {
  it('普通输入返回 undefined（不属于命令层，调用方应交给 LLM 路径）', async () => {
    const f = makeFixture();
    expect(await f.router.tryHandle('你好，帮我看看代码', 'c1')).toBeUndefined();
  });

  it('未知命令给出提示且不产生事件（无真实调用）', async () => {
    const f = makeFixture();
    const text = await f.handle('c1', '/nope');
    expect(text).toContain('未知命令：/nope');
    expect(text).toContain('/help');
    const cmdEvents = f.events.filter(
      (event) => event.type === 'command_invoked' || event.type === 'command_finished',
    );
    expect(cmdEvents).toHaveLength(0);
  });

  it('单独斜杠（空命令）给出明确提示', async () => {
    const f = makeFixture();
    expect(await f.handle('c1', '/')).toContain('（空命令）');
  });
});

// ---------------------------------------------------------------------------
// ② 内置命令输出
// ---------------------------------------------------------------------------

describe('/help', () => {
  it('无参列出全部内置命令', async () => {
    const f = makeFixture();
    const text = await f.handle('c1', '/help');
    expect(text).toContain('可用命令（5 个）');
    for (const name of ['/help', '/status', '/history', '/compact', '/skill']) {
      expect(text).toContain(name);
    }
  });

  it('带参显示单个命令的说明与用法（容忍 /help /status 写法）', async () => {
    const f = makeFixture();
    const text = await f.handle('c1', '/help /status');
    expect(text).toContain('/status');
    expect(text).toContain('用法: /status');
  });
});

describe('/status', () => {
  it('显示会话状态机状态、消息数与检查点数', async () => {
    const f = makeFixture({ script: [{ text: '收到了。' }] });
    f.manager.createSession('c1');

    const before = await f.handle('c1', '/status');
    expect(before).toContain('会话 c1');
    expect(before).toContain('状态: created');
    expect(before).toContain('消息: 0 条');
    expect(before).toContain('mode=every_turn');

    await f.run('c1', '你好');
    const after = await f.handle('c1', '/status');
    expect(after).toContain('状态: completed');
    expect(after).toContain('消息: 3 条'); // system + user + assistant
    expect(after).toContain('检查点: 1 个');
  });
});

describe('/history', () => {
  it('显示最近消息（含角色标签与内容预览）', async () => {
    const f = makeFixture({ script: [{ text: '好的，我在。' }] });
    f.manager.createSession('c1');
    await f.run('c1', '第一句话');

    const text = await f.handle('c1', '/history');
    expect(text).toContain('（共 3 条）');
    expect(text).toContain('[system]');
    expect(text).toContain('[user] 第一句话');
    expect(text).toContain('[assistant] 好的，我在。');
  });

  it('数量参数限制显示条数', async () => {
    const f = makeFixture({ script: [{ text: '好的。' }] });
    f.manager.createSession('c1');
    await f.run('c1', '你好');

    const text = await f.handle('c1', '/history 1');
    expect(text).toContain('显示最近 1 条');
    expect(text).toContain('#3 [assistant] 好的。');
    expect(text).not.toContain('[user] 你好');
  });

  it('非法参数给出明确提示（不静默回退）', async () => {
    const f = makeFixture();
    expect(await f.handle('c1', '/history 0')).toContain('参数无效');
    expect(await f.handle('c1', '/history abc')).toContain('参数无效');
  });
});

describe('/compact', () => {
  it('dry-run 报告分层占用（未触发压缩）且声明不修改历史', async () => {
    const f = makeFixture({ script: [{ text: '好的。' }] });
    f.manager.createSession('c1');
    await f.run('c1', '你好');

    const text = await f.handle('c1', '/compact');
    expect(text).toContain('上下文预演');
    expect(text).toContain('总占用:');
    expect(text).toContain('分层:');
    expect(text).toContain('压缩: 未触发');
    expect(text).toContain('dry-run');
  });

  it('超阈值的工具输出被压缩链截断（报告含 L1 记录）', async () => {
    // toolOutputMaxTokens=10：echo 回显 500 字符（≈125 tok）必超阈值 → L1 触发
    const f = makeFixture({
      script: [
        { text: '回显中……', toolCalls: [{ name: 'echo', args: { message: 'x'.repeat(500) } }] },
        { text: '完成。' },
      ],
      overrides: { context: { toolOutputMaxTokens: 10 } },
    });
    f.manager.createSession('c1');
    await f.run('c1', '请回显长文本');

    const text = await f.handle('c1', '/compact');
    expect(text).toContain('压缩: 已触发');
    expect(text).toContain('[L1]');
  });
});

describe('/skill', () => {
  it('无参列出技能库', async () => {
    const f = makeFixture();
    const text = await f.handle('c1', '/skill');
    expect(text).toContain('可用技能（1 个）');
    expect(text).toContain('math-report（2 步）');
  });

  it('执行技能：参数经 input.text 透传，两步流水账完整', async () => {
    const f = makeFixture();
    const text = await f.handle('c1', '/skill math-report 21 * 2');
    expect(text).toContain('技能 math-report 执行成功');
    expect(text).toContain('1. ✓ calculator: 表达式 21 * 2 = 42');
    expect(text).toContain('2. ✓ echo: 【计算报告】表达式 21 * 2 = 42');
  });

  it('技能层未装配时给出降级提示', async () => {
    const f = makeFixture({ withoutSkills: true });
    expect(await f.handle('c1', '/skill')).toContain('未装配技能层');
  });
});

// ---------------------------------------------------------------------------
// ③ 控制面稳态与事件
// ---------------------------------------------------------------------------

describe('CommandRouter：稳态与事件', () => {
  it('命令内部异常被兜底：返回失败文本 + command_finished(ok=false)', async () => {
    const f = makeFixture();
    f.registry.register({
      name: 'boom',
      description: '故意抛异常的命令',
      run: () => {
        throw new Error('内部炸了');
      },
    });

    const text = await f.handle('c1', '/boom');
    expect(text).toContain('执行失败');
    expect(text).toContain('内部炸了');

    const finished = f.events.find(
      (event) => event.type === 'command_finished' && event.command === 'boom',
    );
    expect(finished?.type === 'command_finished' && finished.ok).toBe(false);
  });

  it('成功命令的事件序列：invoked → finished(ok=true) 且时长可计量', async () => {
    const f = makeFixture();
    f.manager.createSession('c1');
    await f.handle('c1', '/status');

    const cmdEvents = f.events.filter(
      (event) => event.type === 'command_invoked' || event.type === 'command_finished',
    );
    expect(cmdEvents.map((event) => event.type)).toEqual(['command_invoked', 'command_finished']);
    const invoked = cmdEvents[0];
    expect(invoked?.type === 'command_invoked' && invoked.command).toBe('status');
    const finished = cmdEvents[1];
    expect(finished?.type === 'command_finished' && finished.ok).toBe(true);
    expect(typeof (finished?.type === 'command_finished' ? finished.durationMs : undefined)).toBe(
      'number',
    );
  });

  it('硬证据：执行全部命令不产生任何 LLM 请求（命令不进模型）', async () => {
    const f = makeFixture();
    f.manager.createSession('c1');

    await f.handle('c1', '/help');
    await f.handle('c1', '/status');
    await f.handle('c1', '/history');
    await f.handle('c1', '/compact');
    await f.handle('c1', '/skill math-report 2 + 2');

    expect(f.provider.requests).toHaveLength(0);
  });
});
