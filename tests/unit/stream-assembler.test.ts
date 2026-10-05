/**
 * StreamAssembler 单元测试 —— 协议层最重要的测试面。
 * 锚定的决策（ADR-008）：
 *   - 参数 JSON 只在 tool_call_end 时整体 parse（绝不「半个 JSON」）；
 *   - 错拼类问题（未知 id / 重复 start / 终态后事件）→ internal_error 快速失败；
 *   - 截断类问题分层：无 message_end → provider_error（可重试）；
 *     参数 JSON 残缺 / 调用未闭合 → 降级 parseError（错误即数据，交给模型修正）。
 */

import { describe, expect, it } from 'vitest';
import { HarnessError } from '../../src/errors.ts';
import { StreamAssembler, assembleStream } from '../../src/llm/stream-assembler.ts';
import type { StreamEvent } from '../../src/types.ts';

/** 把事件字面量列表变成 AsyncIterable（模拟 provider.stream 的输出） */
function events(...list: StreamEvent[]): AsyncIterable<StreamEvent> {
  return (async function* generate() {
    for (const event of list) yield event;
  })();
}

const USAGE = { inputTokens: 10, outputTokens: 5 };

describe('StreamAssembler', () => {
  it('完整流：文本 + 工具调用正常组装', async () => {
    const result = await assembleStream(
      events(
        { type: 'text_delta', text: '让我算' },
        { type: 'text_delta', text: '一下' },
        { type: 'tool_call_start', id: 'c1', name: 'calculator' },
        { type: 'tool_call_delta', id: 'c1', argsDelta: '{"expression":' },
        { type: 'tool_call_delta', id: 'c1', argsDelta: '"1+1"}' },
        { type: 'tool_call_end', id: 'c1' },
        { type: 'message_end', stopReason: 'tool_use', usage: USAGE },
      ),
    );
    expect(result.message.role).toBe('assistant');
    expect(result.message.content).toBe('让我算一下');
    expect(result.message.toolCalls).toHaveLength(1);
    expect(result.message.toolCalls?.[0]?.name).toBe('calculator');
    // 关键断言：分片只在 end 时整体 parse，得到完整对象
    expect(result.message.toolCalls?.[0]?.args).toEqual({ expression: '1+1' });
    expect(result.message.toolCalls?.[0]?.argsRaw).toBe('{"expression":"1+1"}');
    expect(result.message.toolCalls?.[0]?.parseError).toBeUndefined();
    expect(result.stopReason).toBe('tool_use');
    expect(result.usage).toEqual(USAGE);
  });

  it('多个 tool_call 按完成顺序互不串台', async () => {
    const result = await assembleStream(
      events(
        { type: 'tool_call_start', id: 'a', name: 't1' },
        { type: 'tool_call_start', id: 'b', name: 't2' },
        { type: 'tool_call_delta', id: 'a', argsDelta: '{"x":1}' },
        { type: 'tool_call_end', id: 'a' },
        { type: 'tool_call_delta', id: 'b', argsDelta: '{"y":2}' },
        { type: 'tool_call_end', id: 'b' },
        { type: 'message_end', stopReason: 'tool_use', usage: USAGE },
      ),
    );
    expect(result.message.toolCalls?.map((c) => c.name)).toEqual(['t1', 't2']);
    expect(result.message.toolCalls?.[0]?.args).toEqual({ x: 1 });
    expect(result.message.toolCalls?.[1]?.args).toEqual({ y: 2 });
  });

  it('onTextDelta 即到即显：每个分片实时回调', async () => {
    const seen: string[] = [];
    await assembleStream(
      events(
        { type: 'text_delta', text: 'AB' },
        { type: 'text_delta', text: 'C' },
        { type: 'message_end', stopReason: 'end_turn', usage: USAGE },
      ),
      { onTextDelta: (t) => seen.push(t) },
    );
    expect(seen).toEqual(['AB', 'C']);
  });

  it('空参数（argsRaw 为空串）→ args 视为 {}', async () => {
    const result = await assembleStream(
      events(
        { type: 'tool_call_start', id: 'c1', name: 'noop' },
        { type: 'tool_call_end', id: 'c1' },
        { type: 'message_end', stopReason: 'tool_use', usage: USAGE },
      ),
    );
    expect(result.message.toolCalls?.[0]?.args).toEqual({});
  });

  it('参数 JSON 残缺：不抛错，降级为 parseError（错误即数据）', async () => {
    const result = await assembleStream(
      events(
        { type: 'tool_call_start', id: 'c1', name: 'calculator' },
        { type: 'tool_call_delta', id: 'c1', argsDelta: '{"expression": "1+' },
        { type: 'tool_call_end', id: 'c1' },
        { type: 'message_end', stopReason: 'tool_use', usage: USAGE },
      ),
    );
    const call = result.message.toolCalls?.[0];
    expect(call?.args).toBeUndefined();
    expect(call?.argsRaw).toBe('{"expression": "1+');
    expect(call?.parseError).toContain('JSON 解析失败');
  });

  it('tool_call 未闭合但有 message_end：降级为 parseError', async () => {
    const result = await assembleStream(
      events(
        { type: 'tool_call_start', id: 'c1', name: 'search' },
        { type: 'tool_call_delta', id: 'c1', argsDelta: '{"q":' },
        { type: 'message_end', stopReason: 'tool_use', usage: USAGE },
      ),
    );
    expect(result.message.toolCalls?.[0]?.parseError).toContain('未闭合');
  });

  it('delta 指向未打开的调用 id → internal_error（协议违规快速失败）', async () => {
    await expect(
      assembleStream(
        events({ type: 'tool_call_delta', id: 'ghost', argsDelta: '{}' }),
      ),
    ).rejects.toMatchObject({ code: 'internal_error' });
  });

  it('重复的 tool_call_start id → internal_error', async () => {
    await expect(
      assembleStream(
        events(
          { type: 'tool_call_start', id: 'c1', name: 't' },
          { type: 'tool_call_start', id: 'c1', name: 't' },
        ),
      ),
    ).rejects.toMatchObject({ code: 'internal_error' });
  });

  it('流截断（没有 message_end）→ provider_error（可重试）', async () => {
    await expect(
      assembleStream(events({ type: 'text_delta', text: '说到一半' })),
    ).rejects.toMatchObject({ code: 'provider_error', retryable: true });
  });

  it('message_end 之后继续 feed → internal_error（终态保护）', () => {
    const assembler = new StreamAssembler();
    assembler.feed({ type: 'message_end', stopReason: 'end_turn', usage: USAGE });
    expect(assembler.ended).toBe(true);
    expect(() => assembler.feed({ type: 'text_delta', text: '迟到' })).toThrow(HarnessError);
  });

  it('异常是 HarnessError 实例（错误语言统一）', async () => {
    await expect(assembleStream(events())).rejects.toBeInstanceOf(HarnessError);
  });
});
