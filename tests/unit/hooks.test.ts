/**
 * HookPipeline 与内置 hook 单元测试。
 * 锚定的决策：
 *   - 排序稳定、按事件路由；
 *   - 5 种 outcome 的流转语义（modify 链式更新、block 终止、skip 短路）；
 *   - hook 异常隔离（ADR-009）：抛错不阻断主流程，错误进事件流；
 *   - 内置 hook 的行为契约（熔断计数、脱敏命中、截断标记、审计日志）。
 */

import { describe, expect, it } from 'vitest';
import { EventBus } from '../../src/kernel/events.ts';
import { HookPipeline } from '../../src/hooks/pipeline.ts';
import { createAuditHook } from '../../src/hooks/builtin/audit.ts';
import { createRedactResultHook } from '../../src/hooks/builtin/redact-result.ts';
import { createRepeatGuardHook } from '../../src/hooks/builtin/repeat-guard.ts';
import { createTruncateResultHook } from '../../src/hooks/builtin/truncate-result.ts';
import { createDefaultHooks } from '../../src/hooks/builtin/index.ts';
import type { HarnessEvent } from '../../src/kernel/events.ts';
import type { Hook, HookContext, HookEventName, HookPayload, ToolResult } from '../../src/types.ts';
import { okResult } from '../../src/types.ts';

// ---------------------------------------------------------------------------
// 测试装置
// ---------------------------------------------------------------------------

function makeHookCtx(logs: string[] = []): HookContext {
  return { sessionId: 's1', queryId: 'q1', now: () => 0, log: (m) => logs.push(m) };
}

function makePayload(event: HookEventName, extra: Partial<HookPayload> = {}): HookPayload {
  return {
    event,
    sessionId: 's1',
    queryId: 'q1',
    toolCall: { id: 'c1', name: 'echo', args: { message: 'x' }, argsRaw: '{"message":"x"}' },
    tool: { name: 'echo', risk: 'low' },
    ...extra,
  };
}

function makeHook(
  name: string,
  priority: number,
  events: HookEventName[],
  handler: Hook['handler'],
): Hook {
  return { name, priority, events, handler };
}

// ---------------------------------------------------------------------------
// 管道语义
// ---------------------------------------------------------------------------

describe('HookPipeline', () => {
  it('按 priority 升序执行（数字小者先）；同优先级保持注册序', async () => {
    const order: string[] = [];
    const pipeline = new HookPipeline({
      hooks: [
        makeHook('c', 30, ['tool_call_before'], async () => (order.push('c'), { kind: 'continue' })),
        makeHook('a', 10, ['tool_call_before'], async () => (order.push('a'), { kind: 'continue' })),
        makeHook('b', 20, ['tool_call_before'], async () => (order.push('b'), { kind: 'continue' })),
      ],
    });
    await pipeline.run(makePayload('tool_call_before'), makeHookCtx());
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('按事件路由：未声明该事件的 hook 不执行', async () => {
    let called = false;
    const pipeline = new HookPipeline({
      hooks: [makeHook('only-post', 10, ['tool_call_after'], async () => ((called = true), { kind: 'continue' }))],
    });
    await pipeline.run(makePayload('tool_call_before'), makeHookCtx());
    expect(called).toBe(false);
  });

  it('modify_input 链式更新：后续 hook 与最终 outcome 都看到新值', async () => {
    const seen: unknown[] = [];
    const pipeline = new HookPipeline({
      hooks: [
        makeHook('first', 10, ['tool_call_before'], async () => ({ kind: 'modify_input', input: { message: 'v2' } })),
        makeHook('second', 20, ['tool_call_before'], async (payload) => {
          seen.push(payload.input);
          return { kind: 'continue' };
        }),
      ],
    });
    const outcome = await pipeline.run(makePayload('tool_call_before', { input: { message: 'v1' } }), makeHookCtx());
    expect(seen).toEqual([{ message: 'v2' }]);
    expect(outcome.input).toEqual({ message: 'v2' });
    expect(outcome.blocked).toBeUndefined();
  });

  it('modify_result 更新结果；block 立即终止且后续 hook 不执行', async () => {
    let afterBlockCalled = false;
    const processed: ToolResult = { ok: true, content: 'processed' };
    const pipeline = new HookPipeline({
      hooks: [
        makeHook('mod', 10, ['tool_call_after'], async () => ({ kind: 'modify_result', result: processed })),
        makeHook('blocker', 20, ['tool_call_after'], async () => ({ kind: 'block', reason: '不接受' })),
        makeHook('never', 30, ['tool_call_after'], async () => ((afterBlockCalled = true), { kind: 'continue' })),
      ],
    });
    const outcome = await pipeline.run(
      makePayload('tool_call_after', { result: okResult('raw') }),
      makeHookCtx(),
    );
    expect(outcome.result).toEqual(processed);
    expect(outcome.blocked).toEqual({ reason: '不接受' });
    expect(afterBlockCalled).toBe(false);
  });

  it('skip：短路后续 hook 但不阻断（blocked 为空）', async () => {
    let afterSkipCalled = false;
    const pipeline = new HookPipeline({
      hooks: [
        makeHook('skipper', 10, ['tool_call_before'], async () => ({ kind: 'skip' })),
        makeHook('never', 20, ['tool_call_before'], async () => ((afterSkipCalled = true), { kind: 'continue' })),
      ],
    });
    const outcome = await pipeline.run(makePayload('tool_call_before'), makeHookCtx());
    expect(afterSkipCalled).toBe(false);
    expect(outcome.blocked).toBeUndefined();
  });

  it('hook 抛错被隔离：后续 hook 照跑、主流程正常、错误进事件流（ADR-009）', async () => {
    const bus = new EventBus();
    const events: HarnessEvent[] = [];
    bus.on('*', (e) => events.push(e));
    let secondCalled = false;
    const pipeline = new HookPipeline({
      hooks: [
        makeHook('broken', 10, ['tool_call_before'], async () => {
          throw new Error('hook 内部爆炸');
        }),
        makeHook('healthy', 20, ['tool_call_before'], async () => ((secondCalled = true), { kind: 'continue' })),
      ],
      bus,
    });
    const outcome = await pipeline.run(makePayload('tool_call_before'), makeHookCtx());
    expect(secondCalled).toBe(true);
    expect(outcome.blocked).toBeUndefined();
    const hookErrors = events.filter((e) => e.type === 'hook_error');
    expect(hookErrors).toHaveLength(1);
    expect(hookErrors[0]).toMatchObject({ hookName: 'broken', message: 'hook 内部爆炸' });
  });

  it('事件上报：hook_invoked 与 hook_outcome 成对出现', async () => {
    const bus = new EventBus();
    const events: HarnessEvent[] = [];
    bus.on('*', (e) => events.push(e));
    const pipeline = new HookPipeline({
      hooks: [makeHook('a', 10, ['tool_call_before'], async () => ({ kind: 'continue' }))],
      bus,
    });
    await pipeline.run(makePayload('tool_call_before'), makeHookCtx());
    expect(events.map((e) => e.type)).toEqual(['hook_invoked', 'hook_outcome']);
  });
});

// ---------------------------------------------------------------------------
// 内置 hook
// ---------------------------------------------------------------------------

describe('repeat-guard', () => {
  it('连续第 threshold 次相同调用 → block；不同调用重置计数', async () => {
    const guard = createRepeatGuardHook({ threshold: 3 });
    const ctx = makeHookCtx();
    const call = makePayload('tool_call_before', {
      toolCall: { id: '1', name: 'echo', args: { message: 'x' }, argsRaw: '{"message":"x"}' },
    });
    const run = (payload: HookPayload) => guard.handler(payload, ctx);

    expect((await run(call)).kind).toBe('continue'); // 1
    expect((await run(call)).kind).toBe('continue'); // 2
    expect((await run(call)).kind).toBe('block'); // 3 → 熔断

    // 换一个调用后再回来 → 计数重置
    const other = makePayload('tool_call_before', {
      toolCall: { id: '2', name: 'echo', args: { message: 'y' }, argsRaw: '{"message":"y"}' },
    });
    expect((await run(other)).kind).toBe('continue');
    expect((await run(call)).kind).toBe('continue'); // 重置后第 1 次
  });

  it('签名稳定：参数键序变化不影响熔断判定', async () => {
    const guard = createRepeatGuardHook({ threshold: 2 });
    const ctx = makeHookCtx();
    const mk = (args: Record<string, unknown>) =>
      makePayload('tool_call_before', {
        toolCall: { id: '1', name: 'tool', args, argsRaw: JSON.stringify(args) },
      });
    // 两个对象键序不同、内容相同
    const a = { alpha: 1, beta: 2 };
    const b = { beta: 2, alpha: 1 };
    expect((await guard.handler(mk(a), ctx)).kind).toBe('continue');
    expect((await guard.handler(mk(b), ctx)).kind).toBe('block'); // 键序无关 → 命中同一签名
  });
});

describe('redact-result', () => {
  it('API key / Bearer / password 命中 → modify_result 替换内容', async () => {
    const hook = createRedactResultHook();
    const ctx = makeHookCtx();
    const cases = [
      'token: sk-abcdef1234567890XYZ',
      'Authorization: Bearer abc.def.ghi12345',
      'password="hunter2secret"',
    ];
    for (const text of cases) {
      const outcome = await hook.handler(
        makePayload('tool_call_after', { result: okResult(text) }),
        ctx,
      );
      expect(outcome.kind).toBe('modify_result');
      if (outcome.kind === 'modify_result') {
        expect(outcome.result.content).toContain('[REDACTED');
        expect(outcome.result.ok).toBe(true); // 判别形状保持
      }
    }
  });

  it('无敏感内容 → continue（零改动通过）', async () => {
    const hook = createRedactResultHook();
    const outcome = await hook.handler(
      makePayload('tool_call_after', { result: okResult('普通结果，没有秘密') }),
      makeHookCtx(),
    );
    expect(outcome.kind).toBe('continue');
  });
});

describe('truncate-result', () => {
  it('超长结果 → 头尾保留 + 显式省略标记', async () => {
    const hook = createTruncateResultHook({ maxChars: 100 });
    const content = `${'H'.repeat(500)}TAIL`;
    const outcome = await hook.handler(
      makePayload('tool_call_after', { result: okResult(content) }),
      makeHookCtx(),
    );
    expect(outcome.kind).toBe('modify_result');
    if (outcome.kind === 'modify_result') {
      expect(outcome.result.content).toContain('已省略');
      expect(outcome.result.content.startsWith('H'.repeat(60))).toBe(true); // headRatio 0.6
      expect(outcome.result.content.endsWith('TAIL')).toBe(true); // 尾部保留
    }
  });

  it('未超限 → continue', async () => {
    const hook = createTruncateResultHook({ maxChars: 100 });
    const outcome = await hook.handler(
      makePayload('tool_call_after', { result: okResult('短内容') }),
      makeHookCtx(),
    );
    expect(outcome.kind).toBe('continue');
  });
});

describe('audit', () => {
  it('生成单行审计日志（含工具名与状态），且不修改结果', async () => {
    const logs: string[] = [];
    const hook = createAuditHook();
    const outcome = await hook.handler(
      makePayload('tool_call_after', { result: okResult('data'), input: { message: 'x' } }),
      makeHookCtx(logs),
    );
    expect(outcome.kind).toBe('continue');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('[audit]');
    expect(logs[0]).toContain('tool=echo');
    expect(logs[0]).toContain('status=ok');
  });
});

describe('createDefaultHooks', () => {
  it('返回 4 个默认 hook（重复熔断 + 审计 + 脱敏 + 截断）', () => {
    const hooks = createDefaultHooks({ repeatCallThreshold: 3 });
    expect(hooks.map((h) => h.name).sort()).toEqual(
      ['audit', 'redact-result', 'repeat-guard', 'truncate-result'].sort(),
    );
  });
});
