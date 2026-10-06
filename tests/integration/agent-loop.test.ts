/**
 * AgentLoop 集成测试 —— 内核主循环的完整路径验证。
 *
 * 覆盖矩阵（对齐文件头「五个关键设计决策」的每一条）：
 *   ① generator 契约：事件序列 + completed 终态信封 + return 值
 *   ② 双通道：LoopEvent（yield）与 HarnessEvent（bus）各自的内容
 *   ③ 工具闭环：串行执行、结果写回、下一轮上下文增长
 *   ④ 错误分类学：工具错误收敛为结果 vs LLM 致命错误向上抛
 *   ⑤ 取消语义：预检取消 / 流中途取消 / 工具执行中取消（补消息协议）
 *   附加：maxTurns 硬约束、system prompt 注入幂等
 */

import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { defineConfig } from '../../src/config.ts';
import { AgentLoop } from '../../src/kernel/agent-loop.ts';
import type { LoopContext, LoopEvent, LoopResult } from '../../src/kernel/agent-loop.ts';
import { Dispatcher } from '../../src/kernel/dispatcher.ts';
import type { HarnessEvent } from '../../src/kernel/events.ts';
import { EventBus } from '../../src/kernel/events.ts';
import { FakeProvider } from '../../src/llm/fake-provider.ts';
import type { FakeTurn } from '../../src/llm/fake-provider.ts';
import { HookPipeline } from '../../src/hooks/pipeline.ts';
import { PermissionGate } from '../../src/permission/gate.ts';
import { calculatorTool, echoTool } from '../../src/tools/builtin/index.ts';
import { ToolRegistry } from '../../src/tools/registry.ts';
import type { AnyTool, Hook, Message } from '../../src/types.ts';
import { systemMessage } from '../../src/types.ts';

// ---------------------------------------------------------------------------
// 测试装置
// ---------------------------------------------------------------------------

interface LoopFixture {
  readonly loop: AgentLoop;
  readonly provider: FakeProvider;
  readonly bus: EventBus;
  /** 全量 HarnessEvent 收集（诊断通道断言用） */
  readonly events: HarnessEvent[];
}

interface FixtureOptions {
  readonly maxTurns?: number;
  readonly chunkSize?: number;
  readonly systemPrompt?: string;
  readonly tools?: readonly AnyTool[];
  readonly hooks?: readonly Hook[];
}

function makeFixture(script: readonly FakeTurn[], options: FixtureOptions = {}): LoopFixture {
  const config = defineConfig(
    options.maxTurns !== undefined ? { loop: { maxTurns: options.maxTurns } } : {},
  );
  const registry = new ToolRegistry();
  for (const tool of options.tools ?? [echoTool]) {
    registry.register(tool);
  }
  const bus = new EventBus();
  const events: HarnessEvent[] = [];
  bus.on('*', (event) => events.push(event));

  const hooks = new HookPipeline({ hooks: options.hooks ?? [], bus });
  const permission = new PermissionGate({ config: config.permission });
  const dispatcher = new Dispatcher({ registry, hooks, permission, bus, config });
  const provider = new FakeProvider({
    script,
    ...(options.chunkSize !== undefined ? { chunkSize: options.chunkSize } : {}),
  });
  const loop = new AgentLoop({
    provider,
    dispatcher,
    registry,
    bus,
    config,
    ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
  });
  return { loop, provider, bus, events };
}

function mkCtx(signal?: AbortSignal): LoopContext {
  return {
    sessionId: 's1',
    queryId: 'q1',
    workingDir: process.cwd(),
    signal: signal ?? new AbortController().signal,
  };
}

/**
 * 消费整个 generator：收集事件 + 从 completed 信封提取结果。
 * 若正常路径没有产出 completed 信封，说明契约被破坏——测试直接失败。
 */
async function collect(
  gen: AsyncGenerator<LoopEvent, LoopResult, void>,
  onEvent?: (event: LoopEvent) => void,
): Promise<{ events: LoopEvent[]; result: LoopResult }> {
  const events: LoopEvent[] = [];
  let result: LoopResult | undefined;
  for await (const event of gen) {
    onEvent?.(event);
    events.push(event);
    if (event.type === 'completed') result = event.result;
  }
  if (result === undefined) {
    throw new Error('Loop 未产出 completed 终态信封（正常路径必定产出）');
  }
  return { events, result };
}

function joinText(events: readonly LoopEvent[]): string {
  let text = '';
  for (const event of events) {
    if (event.type === 'text_delta') text += event.text;
  }
  return text;
}

// ---------------------------------------------------------------------------
// 基础路径
// ---------------------------------------------------------------------------

describe('AgentLoop 基础路径', () => {
  it('单轮问答：流式文本转发、自然终结、历史与用量正确', async () => {
    const f = makeFixture([{ text: '你好世界' }]);
    const { events, result } = await collect(f.loop.run('打个招呼', [], mkCtx()));

    // LoopEvent 序列：turn_started → text_delta* → completed
    expect(events.map((e) => e.type)).toEqual(['turn_started', 'text_delta', 'completed']);
    // 分片边界对消费方透明：拼接后是完整回答
    expect(joinText(events)).toBe('你好世界');

    expect(result.stopReason).toBe('completed');
    expect(result.turns).toBe(1);
    expect(result.finalMessage?.content).toBe('你好世界');
    expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);

    // 诊断通道（bus）：查询生命周期 + 模型调用成对出现
    const types = f.events.map((e) => e.type);
    expect(types).toContain('query_start');
    expect(types).toContain('llm_request');
    expect(types).toContain('llm_response');
    expect(f.events.find((e) => e.type === 'query_end')).toMatchObject({
      stopReason: 'completed',
      turns: 1,
    });
  });

  it('工具闭环：模型调用工具 → 框架执行 → 结果注入 → 模型总结（两轮完成）', async () => {
    const f = makeFixture([
      { text: '我来调用工具', toolCalls: [{ name: 'echo', args: { message: 'hi' } }] },
      { text: '完成：hi' },
    ]);
    const { events, result } = await collect(f.loop.run('帮我回显 hi', [], mkCtx()));

    // 工具活动的用户可见事件（LoopEvent 通道）
    const toolStarted = events.filter((e) => e.type === 'tool_started');
    const toolFinished = events.filter((e) => e.type === 'tool_finished');
    expect(toolStarted).toHaveLength(1);
    expect(toolStarted[0]).toMatchObject({ name: 'echo', args: { message: 'hi' } });
    expect(toolFinished).toHaveLength(1);
    expect(toolFinished[0]).toMatchObject({ name: 'echo', result: { ok: true, content: 'hi' } });

    expect(result.turns).toBe(2);
    expect(result.stopReason).toBe('completed');
    // 消息历史的协议形状：assistant(tool_calls) 后必须紧跟 tool 结果
    expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(result.messages[2]).toMatchObject({ role: 'tool', content: 'hi', name: 'echo' });
    expect(result.finalMessage?.content).toBe('完成：hi');

    // 第二轮请求的上下文包含了工具结果（1 条 → 3 条）
    expect(f.provider.requests).toHaveLength(2);
    expect(f.provider.requests[0]?.messages.length).toBe(1);
    expect(f.provider.requests[1]?.messages.length).toBe(3);
  });

  it('maxTurns 硬约束：模型持续请求工具 → 框架在第 N 轮终止（max_turns）', async () => {
    const f = makeFixture(
      [
        { toolCalls: [{ name: 'echo', args: { message: 'a' } }] },
        { toolCalls: [{ name: 'echo', args: { message: 'b' } }] },
        { text: '不会到达的第三轮' },
      ],
      { maxTurns: 2 },
    );
    const { result } = await collect(f.loop.run('开始', [], mkCtx()));

    expect(result.stopReason).toBe('max_turns');
    expect(result.turns).toBe(2);
    expect(f.provider.consumedTurns).toBe(2); // 第三轮脚本未被消费
    expect(f.events.find((e) => e.type === 'query_end')).toMatchObject({
      stopReason: 'max_turns',
      turns: 2,
    });
  });

  it('system prompt 注入：置于消息首位；history 已含 system 时刷新为最新值（不重复）', async () => {
    const f1 = makeFixture([{ text: 'ok' }], { systemPrompt: '你是演示助手' });
    await collect(f1.loop.run('hi', [], mkCtx()));
    expect(f1.provider.requests[0]?.messages[0]).toMatchObject({
      role: 'system',
      content: '你是演示助手',
    });

    // 已有 system 的形态（w10 Session 恢复后的场景）——w18 起刷新为当前
    // systemPrompt（旧快照可能缺少工具/技能清单），消息数不增
    const f2 = makeFixture([{ text: 'ok' }], { systemPrompt: '你是演示助手' });
    const historyWithSystem: Message[] = [systemMessage('既有 system')];
    await collect(f2.loop.run('hi', historyWithSystem, mkCtx()));
    expect(f2.provider.requests[0]?.messages[0]).toMatchObject({ content: '你是演示助手' });
    expect(
      f2.provider.requests[0]?.messages.filter((m) => m.role === 'system'),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 取消语义（决策 ⑤ 的三个检查点）
// ---------------------------------------------------------------------------

describe('AgentLoop 取消语义', () => {
  it('预检取消：signal 已 aborted → 直接终结（aborted），零模型调用', async () => {
    const f = makeFixture([{ text: 'x' }]);
    const controller = new AbortController();
    controller.abort();

    const { events, result } = await collect(f.loop.run('hi', [], mkCtx(controller.signal)));
    expect(result.stopReason).toBe('aborted');
    expect(result.turns).toBe(0);
    expect(f.provider.consumedTurns).toBe(0);
    expect(events.map((e) => e.type)).toEqual(['completed']); // 连 turn_started 都没有
  });

  it('流中途取消：文本只到一半，AbortError 被收敛为 aborted（不向上抛）', async () => {
    const fullText = '这是一段很长的回答内容';
    const f = makeFixture([{ text: fullText }], { chunkSize: 1 });
    const controller = new AbortController();

    const { events, result } = await collect(
      f.loop.run('hi', [], mkCtx(controller.signal)),
      (event) => {
        if (event.type === 'text_delta') controller.abort(); // 收到第一个分片即取消
      },
    );

    const text = joinText(events);
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThan(fullText.length); // 只收到部分分片
    expect(result.stopReason).toBe('aborted');
    // 半截回答不进入历史：assistant 消息未组装完成
    expect(result.messages.map((m) => m.role)).toEqual(['user']);
    expect(result.finalMessage).toBeUndefined();
  });

  it('工具执行中取消：为未完成的调用补占位结果，保证历史协议完整', async () => {
    const controller = new AbortController();
    const cancellingTool: AnyTool = {
      name: 'canceller',
      description: '执行时触发取消（测试专用）',
      inputSchema: z.object({ value: z.string().default('v') }),
      risk: 'low',
      async execute() {
        controller.abort();
        throw new DOMException('工具已取消', 'AbortError');
      },
    };
    const f = makeFixture(
      [
        {
          toolCalls: [
            { name: 'canceller', args: { value: 'a' } },
            { name: 'canceller', args: { value: 'b' } },
          ],
        },
      ],
      { tools: [cancellingTool] },
    );

    const { result } = await collect(f.loop.run('go', [], mkCtx(controller.signal)));

    expect(result.stopReason).toBe('aborted');
    // 关键断言：assistant 声明了 2 个调用 → 必须恰好有 2 条 tool 消息配对
    expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool']);
    expect(result.messages[2]).toMatchObject({
      role: 'tool',
      content: '（调用因会话取消而中止）',
      name: 'canceller',
    });
    expect(result.messages[3]).toMatchObject({ role: 'tool', name: 'canceller' });
  });
});

// ---------------------------------------------------------------------------
// 错误分类学（决策 ④）
// ---------------------------------------------------------------------------

describe('AgentLoop 错误边界', () => {
  it('LLM 致命错误向上抛；query_end 记账为 error（异常路径也经过统一出口）', async () => {
    const f = makeFixture([{ fail: { code: 'provider_error', message: '模拟断网' } }]);

    await expect(collect(f.loop.run('hi', [], mkCtx()))).rejects.toThrow('模拟断网');
    expect(f.events.find((e) => e.type === 'query_end')).toMatchObject({ stopReason: 'error' });
  });

  it('工具层错误收敛为结果注入历史：模型可见失败原因并自我修正', async () => {
    // calculator 无法计算非法表达式：错误应变成工具结果，而不是让循环崩掉
    const f = makeFixture(
      [
        { toolCalls: [{ name: 'calculator', args: { expression: '1 + * 2' } }] },
        { text: '已修正表达式' },
      ],
      { tools: [calculatorTool] },
    );

    const { result } = await collect(f.loop.run('计算 1 + * 2', [], mkCtx()));

    expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    const toolMsg = result.messages.find(
      (m): m is Extract<Message, { role: 'tool' }> => m.role === 'tool',
    );
    // 工具给出的修正提示进入了历史（模型下一轮能看到）
    expect(toolMsg?.content).toContain('无法计算');
    expect(result.stopReason).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// 轮次快照接缝（w10 决策 ⑥：onTurnEnd）
// ---------------------------------------------------------------------------

describe('AgentLoop 轮次快照接缝', () => {
  it('工具轮末尾回调快照（turn 递增、消息单调增长）；终结轮不回调', async () => {
    const f = makeFixture([
      { text: '调用', toolCalls: [{ name: 'echo', args: { message: 'a' } }] },
      { text: '再调用', toolCalls: [{ name: 'echo', args: { message: 'b' } }] },
      { text: '完成' },
    ]);
    const snapshots: { turn: number; length: number; sessionId: string }[] = [];
    const { result } = await collect(
      f.loop.run('任务', [], mkCtx(), {
        onTurnEnd: (snapshot) =>
          snapshots.push({
            turn: snapshot.turn,
            length: snapshot.messages.length,
            sessionId: snapshot.sessionId,
          }),
      }),
    );

    expect(result.stopReason).toBe('completed');
    // 两个工具轮的末尾各回调一次；纯文本终结轮由 LoopResult 交付，不回调
    expect(snapshots.map((s) => s.turn)).toEqual([1, 2]);
    // 轮 1 末尾 = user + assistant + tool；轮 2 末尾 = 再 + assistant + tool
    expect(snapshots.map((s) => s.length)).toEqual([3, 5]);
    // 快照携带会话维度（持久化消费方的事件关联需要）
    expect(snapshots[0]?.sessionId).toBe('s1');
  });

  it('无工具调用（单轮终答）→ 不回调（一致状态由 LoopResult 统一交付）', async () => {
    const f = makeFixture([{ text: '直接答' }]);
    let calls = 0;
    await collect(f.loop.run('问', [], mkCtx(), { onTurnEnd: () => (calls += 1) }));
    expect(calls).toBe(0);
  });
});
