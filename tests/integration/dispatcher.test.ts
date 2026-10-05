/**
 * Dispatcher 四步执行链集成测试 —— 把 ToolRegistry / HookPipeline / PermissionGate
 * 组装成真实链路，验证「所有工具调用收敛到唯一入口」的全部关键路径。
 *
 * 覆盖矩阵（四步链的每个步骤 × 成功/失败分支）：
 *   快速路径：parseError / 未知工具
 *   步骤 1：pre-hook block / modify_input / hook 抛错隔离
 *   步骤 2：规则 deny / confirm 放行 / confirm 拒绝 / fail-safe 无通道
 *   步骤 3：zod 失败 / 工具业务失败 / 工具抛异常兜底 / 超时 / AbortError 穿透
 *   步骤 4：post-hook modify_result
 *   集成：默认 hook 集合的 repeat-guard 熔断
 */

import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import type { HarnessConfig } from '../../src/config.ts';
import { defineConfig } from '../../src/config.ts';
import { Dispatcher } from '../../src/kernel/dispatcher.ts';
import type { DispatchContext } from '../../src/kernel/dispatcher.ts';
import type { HarnessEvent } from '../../src/kernel/events.ts';
import { EventBus } from '../../src/kernel/events.ts';
import { createDefaultHooks } from '../../src/hooks/builtin/index.ts';
import { HookPipeline } from '../../src/hooks/pipeline.ts';
import { PermissionGate } from '../../src/permission/gate.ts';
import type { ConfirmHandler } from '../../src/permission/gate.ts';
import type { PermissionRule } from '../../src/permission/rules.ts';
import { calculatorTool, echoTool } from '../../src/tools/builtin/index.ts';
import { ToolRegistry } from '../../src/tools/registry.ts';
import type { AnyTool, Hook, RiskLevel, ToolCall, ToolContext, ToolResult } from '../../src/types.ts';
import { okResult } from '../../src/types.ts';

// ---------------------------------------------------------------------------
// 测试装置
// ---------------------------------------------------------------------------

/** 通用测试工具工厂：schema 固定为 { value?: string（默认 'v'） }，行为由调用方注入 */
function makeTool(options: {
  name: string;
  risk?: RiskLevel;
  execute?: (input: unknown, ctx: ToolContext) => Promise<ToolResult>;
}): AnyTool {
  return {
    name: options.name,
    description: `${options.name}（集成测试工具）`,
    inputSchema: z.object({ value: z.string().default('v') }),
    risk: options.risk ?? 'low',
    execute: options.execute ?? (async (input) => okResult(`ok:${JSON.stringify(input)}`)),
  };
}

let callSeq = 0;
function makeCall(name: string, args: unknown = {}): ToolCall {
  callSeq += 1;
  return { id: `call_${callSeq}`, name, args, argsRaw: JSON.stringify(args) };
}

function makeCtx(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    sessionId: 's1',
    queryId: 'q1',
    workingDir: process.cwd(), // 占位：本文件不执行真实文件操作
    signal: new AbortController().signal,
    ...overrides,
  };
}

interface FixtureOptions {
  readonly tools?: readonly AnyTool[];
  readonly hooks?: readonly Hook[];
  readonly rules?: readonly PermissionRule[];
  readonly confirm?: ConfirmHandler;
  readonly config?: HarnessConfig;
}

interface HarnessFixture {
  readonly dispatcher: Dispatcher;
  readonly bus: EventBus;
  /** 全量事件收集（bus.on('*')），断言事件序列用 */
  readonly events: HarnessEvent[];
}

function makeFixture(options: FixtureOptions = {}): HarnessFixture {
  const config = options.config ?? defineConfig();
  const registry = new ToolRegistry();
  for (const tool of options.tools ?? [echoTool, calculatorTool]) {
    registry.register(tool);
  }
  const bus = new EventBus();
  const events: HarnessEvent[] = [];
  bus.on('*', (event) => events.push(event));
  const hooks = new HookPipeline({ hooks: options.hooks ?? [], bus });
  const permission = new PermissionGate({
    config: config.permission,
    ...(options.rules !== undefined ? { rules: options.rules } : {}),
    ...(options.confirm !== undefined ? { confirm: options.confirm } : {}),
  });
  const dispatcher = new Dispatcher({ registry, hooks, permission, bus, config });
  return { dispatcher, bus, events };
}

// ---------------------------------------------------------------------------
// 主链路
// ---------------------------------------------------------------------------

describe('Dispatcher 四步执行链', () => {
  it('happy path：echo 成功执行，事件按 assembled → decision → started → finished 顺序上报', async () => {
    const { dispatcher, events } = makeFixture();
    const result = await dispatcher.dispatch(makeCall('echo', { message: '你好' }), makeCtx());

    expect(result).toEqual(okResult('你好'));
    expect(events.map((e) => e.type)).toEqual([
      'tool_call_assembled',
      'permission_decision',
      'tool_started',
      'tool_finished',
    ]);
    expect(events.find((e) => e.type === 'permission_decision')).toMatchObject({
      toolName: 'echo',
      risk: 'low',
      decision: 'allow',
    });
    expect(events.find((e) => e.type === 'tool_finished')).toMatchObject({ ok: true });
  });

  it('未知工具：input_error 且提示可用工具列表（引导模型自我修正，不崩溃）', async () => {
    const { dispatcher, events } = makeFixture();
    const result = await dispatcher.dispatch(makeCall('no-such-tool'), makeCtx());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('input_error');
      expect(result.content).toContain('no-such-tool');
      expect(result.content).toContain('echo'); // 可用列表里的样本
    }
    expect(events.filter((e) => e.type === 'tool_started')).toHaveLength(0);
  });

  it('parseError（流式截断产物）：input_error，快速路径不进入任何后续步骤', async () => {
    let executed = false;
    const tool = makeTool({
      name: 'rec',
      execute: async () => ((executed = true), okResult('x')),
    });
    const { dispatcher, events } = makeFixture({ tools: [tool] });
    const call: ToolCall = { ...makeCall('rec'), parseError: 'Unexpected end of JSON input' };

    const result = await dispatcher.dispatch(call, makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('input_error');
    expect(executed).toBe(false);
    expect(events.filter((e) => e.type === 'tool_started')).toHaveLength(0);
    expect(events[0]).toMatchObject({ type: 'tool_call_assembled', parseOk: false });
  });

  it('zod 校验失败：input_error 且 execute 未被调用（校验执行之前）', async () => {
    const { dispatcher, events } = makeFixture();
    const result = await dispatcher.dispatch(makeCall('echo', { message: 123 }), makeCtx());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('input_error');
      expect(result.content).toContain('message'); // 失败说明含字段路径
    }
    expect(events.filter((e) => e.type === 'tool_started')).toHaveLength(0);
  });

  it('工具业务失败也是数据：calculator 非法表达式 → input_error 结果（不抛不崩）', async () => {
    const { dispatcher } = makeFixture();
    const result = await dispatcher.dispatch(makeCall('calculator', { expression: '1 + * 2' }), makeCtx());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('input_error');
      expect(result.content).toContain('无法计算'); // 工具给出的修正提示
    }
  });
});

// ---------------------------------------------------------------------------
// 步骤 2：权限
// ---------------------------------------------------------------------------

describe('Dispatcher × 权限', () => {
  it('规则 deny：permission_denied 结果返回给模型（ADR-005），execute 未调用', async () => {
    let executed = false;
    const tool = makeTool({
      name: 'rec',
      execute: async () => ((executed = true), okResult('x')),
    });
    const { dispatcher, events } = makeFixture({
      tools: [tool],
      rules: [{ match: 'rec', decision: 'deny', reason: '测试封禁' }],
    });

    const result = await dispatcher.dispatch(makeCall('rec'), makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('permission_denied');
      expect(result.content).toContain('测试封禁');
    }
    expect(executed).toBe(false);
    expect(events.find((e) => e.type === 'permission_decision')).toMatchObject({ decision: 'deny' });
  });

  it('confirm 放行：high 风险工具经 handler 确认后正常执行', async () => {
    const { dispatcher, events } = makeFixture({
      tools: [makeTool({ name: 'fs-like', risk: 'high' })],
      confirm: async () => true,
    });

    const result = await dispatcher.dispatch(makeCall('fs-like'), makeCtx());
    expect(result.ok).toBe(true);
    expect(events.find((e) => e.type === 'permission_decision')).toMatchObject({
      risk: 'high',
      decision: 'allow',
    });
  });

  it('confirm 拒绝：permission_denied，execute 未调用', async () => {
    let executed = false;
    const { dispatcher } = makeFixture({
      tools: [
        makeTool({ name: 'fs-like', risk: 'high', execute: async () => ((executed = true), okResult('x')) }),
      ],
      confirm: async () => false,
    });

    const result = await dispatcher.dispatch(makeCall('fs-like'), makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('permission_denied');
    expect(executed).toBe(false);
  });

  it('fail-safe：需要 confirm 但无确认通道 → 拒绝（非交互环境的正确默认）', async () => {
    const { dispatcher } = makeFixture({ tools: [makeTool({ name: 'fs-like', risk: 'high' })] });

    const result = await dispatcher.dispatch(makeCall('fs-like'), makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('permission_denied');
      expect(result.content).toContain('无确认通道');
    }
  });
});

// ---------------------------------------------------------------------------
// 步骤 1 / 4：hook 插槽
// ---------------------------------------------------------------------------

describe('Dispatcher × Hook', () => {
  it('pre-hook block：拦截发生在权限与执行之前（无 permission_decision / tool_started 事件）', async () => {
    let executed = false;
    const blocking: Hook = {
      name: 'blocker',
      priority: 10,
      events: ['tool_call_before'],
      handler: async () => ({ kind: 'block', reason: '教学演示：熔断' }),
    };
    const { dispatcher, events } = makeFixture({
      tools: [makeTool({ name: 'rec', execute: async () => ((executed = true), okResult('x')) })],
      hooks: [blocking],
    });

    const result = await dispatcher.dispatch(makeCall('rec'), makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('permission_denied');
      expect(result.content).toContain('熔断');
    }
    expect(executed).toBe(false);
    expect(events.filter((e) => e.type === 'permission_decision')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'tool_started')).toHaveLength(0);
  });

  it('pre-hook modify_input：后续权限与执行都使用修改后的参数（脱敏场景）', async () => {
    const seen: unknown[] = [];
    const modifier: Hook = {
      name: 'modifier',
      priority: 10,
      events: ['tool_call_before'],
      handler: async (payload) => {
        const original = (payload.input as { value: string }).value;
        return { kind: 'modify_input', input: { value: `masked(${original})` } };
      },
    };
    const { dispatcher } = makeFixture({
      tools: [
        makeTool({
          name: 'rec',
          execute: async (input) => {
            seen.push(input);
            return okResult('x');
          },
        }),
      ],
      hooks: [modifier],
    });

    await dispatcher.dispatch(makeCall('rec', { value: 'secret' }), makeCtx());
    expect(seen).toEqual([{ value: 'masked(secret)' }]);
  });

  it('post-hook modify_result：最终结果被加工（截断/脱敏）后返回', async () => {
    const replacer: Hook = {
      name: 'replacer',
      priority: 10,
      events: ['tool_call_after'],
      handler: async () => ({ kind: 'modify_result', result: okResult('已脱敏结果') }),
    };
    const { dispatcher } = makeFixture({ hooks: [replacer] });

    const result = await dispatcher.dispatch(makeCall('echo', { message: '原始敏感内容' }), makeCtx());
    expect(result).toEqual(okResult('已脱敏结果'));
  });

  it('hook 抛错被隔离：主流程照常完成，错误进事件流（ADR-009）', async () => {
    const broken: Hook = {
      name: 'broken',
      priority: 5,
      events: ['tool_call_before'],
      handler: async () => {
        throw new Error('hook 崩了');
      },
    };
    const { dispatcher, events } = makeFixture({ hooks: [broken] });

    const result = await dispatcher.dispatch(makeCall('echo', { message: 'hi' }), makeCtx());
    expect(result).toEqual(okResult('hi'));
    const hookErrors = events.filter((e) => e.type === 'hook_error');
    expect(hookErrors).toHaveLength(1);
    expect(hookErrors[0]).toMatchObject({ hookName: 'broken', message: 'hook 崩了' });
  });
});

// ---------------------------------------------------------------------------
// 步骤 3：执行与兜底
// ---------------------------------------------------------------------------

describe('Dispatcher × 执行兜底', () => {
  it('工具违反「永不抛」协议：Dispatcher 兜底为 internal_error 结果（最后防线）', async () => {
    const { dispatcher, events } = makeFixture({
      tools: [
        makeTool({
          name: 'boom',
          execute: async () => {
            throw new Error('内部爆炸');
          },
        }),
      ],
    });

    const result = await dispatcher.dispatch(makeCall('boom'), makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('internal_error');
      expect(result.error.message).toContain('内部爆炸');
    }
    expect(events.find((e) => e.type === 'tool_finished')).toMatchObject({
      ok: false,
      errorCode: 'internal_error',
    });
  });

  it('超时保护：慢工具收敛为 timeout 结果（保护而非取消——见 dispatcher 语义注释）', async () => {
    const config = defineConfig({ tools: { defaultTimeoutMs: 50 } });
    const { dispatcher } = makeFixture({
      config,
      tools: [
        makeTool({
          name: 'slow',
          execute: async () => {
            await new Promise((resolve) => setTimeout(resolve, 200));
            return okResult('x');
          },
        }),
      ],
    });

    const result = await dispatcher.dispatch(makeCall('slow'), makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('timeout');
      expect(result.content).toContain('超时');
    }
  });

  it('取消预检：signal 已 aborted → AbortError 穿透（取消是控制流不是错误）', async () => {
    const { dispatcher } = makeFixture();
    const controller = new AbortController();
    controller.abort();

    // 注意：参数必须合法——校验在取消预检之前（校验失败会先返回 input_error 结果）
    await expect(
      dispatcher.dispatch(makeCall('echo', { message: 'x' }), makeCtx({ signal: controller.signal })),
    ).rejects.toThrow(/取消/);
  });

  it('工具主动抛 AbortError：同样穿透（不被兜底吞掉）', async () => {
    const { dispatcher } = makeFixture({
      tools: [
        makeTool({
          name: 'aborter',
          execute: async () => {
            throw new DOMException('工具内部取消', 'AbortError');
          },
        }),
      ],
    });

    await expect(dispatcher.dispatch(makeCall('aborter'), makeCtx())).rejects.toThrow('工具内部取消');
  });
});

// ---------------------------------------------------------------------------
// 端到端：默认 hook 集合
// ---------------------------------------------------------------------------

describe('Dispatcher × 默认 hook 集合（端到端）', () => {
  it('repeat-guard 熔断：连续 3 次相同调用，前两次正常、第 3 次被拦截', async () => {
    const config = defineConfig();
    const { dispatcher } = makeFixture({ config, hooks: createDefaultHooks(config.hooks) });
    const call = makeCall('echo', { message: 'loop' });

    const r1 = await dispatcher.dispatch(call, makeCtx());
    const r2 = await dispatcher.dispatch({ ...call, id: 'c2' }, makeCtx());
    const r3 = await dispatcher.dispatch({ ...call, id: 'c3' }, makeCtx());

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r3.ok).toBe(false);
    if (!r3.ok) {
      expect(r3.error.code).toBe('permission_denied'); // pre-hook block → 拒绝结果
      expect(r3.content).toContain('熔断');
    }
  });
});

// ---------------------------------------------------------------------------
// 事件配对契约（w14 场景层暴露并修复：每次调用必有结局）
// ---------------------------------------------------------------------------

describe('事件配对契约：assembled ↔ finished 每次调用必配对', () => {
  it('未知工具：input_error 结局同样发布（模型幻觉工具名的下场可审计）', async () => {
    const { dispatcher, events } = makeFixture();
    await dispatcher.dispatch(makeCall('no-such-tool'), makeCtx());
    const finished = events.filter((e) => e.type === 'tool_finished');
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({
      name: 'no-such-tool',
      ok: false,
      errorCode: 'input_error',
    });
  });

  it('pre-hook block：permission_denied 结局发布；无 decision / started（有意的不对称）', async () => {
    const blocking: Hook = {
      name: 'blocker',
      priority: 10,
      events: ['tool_call_before'],
      handler: async () => ({ kind: 'block', reason: '集成测试阻断' }),
    };
    const { dispatcher, events } = makeFixture({ hooks: [blocking] });
    await dispatcher.dispatch(makeCall('echo', { message: 'x' }), makeCtx());

    expect(events.filter((e) => e.type === 'permission_decision')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'tool_started')).toHaveLength(0);
    const finished = events.filter((e) => e.type === 'tool_finished');
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ name: 'echo', ok: false, errorCode: 'permission_denied' });
  });

  it('权限 deny 与参数校验失败：结局均发布（拒绝不终止循环、但必留痕）', async () => {
    const denyFixture = makeFixture({
      rules: [{ match: 'echo', decision: 'deny', reason: '测试封禁' }],
    });
    await denyFixture.dispatcher.dispatch(makeCall('echo', { message: 'x' }), makeCtx());
    const denyFinished = denyFixture.events.filter((e) => e.type === 'tool_finished');
    expect(denyFinished).toHaveLength(1);
    expect(denyFinished[0]).toMatchObject({ ok: false, errorCode: 'permission_denied' });

    const vFixture = makeFixture();
    await vFixture.dispatcher.dispatch(makeCall('calculator', { expression: 123 }), makeCtx());
    const vFinished = vFixture.events.filter((e) => e.type === 'tool_finished');
    expect(vFinished).toHaveLength(1);
    expect(vFinished[0]).toMatchObject({ name: 'calculator', ok: false, errorCode: 'input_error' });
  });

  it('AbortError 穿透：取消是控制流不是结局——assembled 已发、finished 不发', async () => {
    const { dispatcher, events } = makeFixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      dispatcher.dispatch(
        makeCall('echo', { message: 'x' }),
        makeCtx({ signal: controller.signal }),
      ),
    ).rejects.toThrow(/取消/);

    expect(events.filter((e) => e.type === 'tool_call_assembled')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'tool_finished')).toHaveLength(0);
  });
});
