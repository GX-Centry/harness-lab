/**
 * FakeProvider 单元测试。
 * 锚定的决策：
 *   - 脚本按序消费、耗尽即报错（测试脚本没写全时快速失败）；
 *   - 事件流逐片可预测（分片大小可控，含 emoji 不被切坏的保证）；
 *   - complete 与 stream 行为严格一致（complete 内部复用 stream）；
 *   - countTokens 中英混排的近似公式单调正确。
 */

import { describe, expect, it } from 'vitest';
import { FakeProvider } from '../../src/llm/fake-provider.ts';
import type { StreamEvent } from '../../src/types.ts';

const REQ = { model: 'test', messages: [{ role: 'user' as const, content: '你好' }] };

async function collect(iter: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

describe('FakeProvider', () => {
  it('脚本按顺序消费：两回合各返回对应文本', async () => {
    const provider = new FakeProvider({ script: [{ text: '第一轮' }, { text: '第二轮' }] });
    const r1 = await provider.complete(REQ);
    const r2 = await provider.complete(REQ);
    expect(r1.message.content).toBe('第一轮');
    expect(r2.message.content).toBe('第二轮');
    expect(provider.consumedTurns).toBe(2);
  });

  it('脚本耗尽 → provider_error（明确提示脚本没写全）', async () => {
    const provider = new FakeProvider({ script: [] });
    await expect(provider.complete(REQ)).rejects.toMatchObject({ code: 'provider_error' });
  });

  it('请求被记录（测试断言「发给模型的上下文」的抓手）', async () => {
    const provider = new FakeProvider({ script: [{ text: 'ok' }] });
    await provider.complete(REQ);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.messages[0]?.content).toBe('你好');
  });

  it('流事件序列可预测：文本按 chunkSize 分片', async () => {
    const provider = new FakeProvider({ script: [{ text: 'abcdef' }], chunkSize: 2 });
    const events = await collect(provider.stream(REQ));
    expect(events).toEqual([
      { type: 'text_delta', text: 'ab' },
      { type: 'text_delta', text: 'cd' },
      { type: 'text_delta', text: 'ef' },
      { type: 'message_end', stopReason: 'end_turn', usage: expect.anything() },
    ]);
  });

  it('emoji 不会被切片切开（按 code point 切分）', async () => {
    const provider = new FakeProvider({ script: [{ text: '👋a好' }], chunkSize: 1 });
    const events = await collect(provider.stream(REQ));
    const text = events
      .filter((e): e is Extract<StreamEvent, { type: 'text_delta' }> => e.type === 'text_delta')
      .map((e) => e.text)
      .join('');
    expect(text).toBe('👋a好');
    // 每个 chunk 都是完整字符（无孤立代理项）
    for (const e of events) {
      if (e.type === 'text_delta') expect([...e.text].length).toBe(1);
    }
  });

  it('工具调用：start/delta/end 生命周期完整，args JSON 可分片重组', async () => {
    const provider = new FakeProvider({
      script: [{ toolCalls: [{ name: 'calculator', args: { expression: '1+1' } }] }],
      chunkSize: 5,
    });
    const events = await collect(provider.stream(REQ));
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('tool_call_start');
    expect(types).toContain('tool_call_delta');
    expect(types.at(-2)).toBe('tool_call_end');
    expect(types.at(-1)).toBe('message_end');
    // stopReason 自动推导为 tool_use
    const end = events.at(-1);
    expect(end).toMatchObject({ type: 'message_end', stopReason: 'tool_use' });
    // 分片重组后与源参数一致（跨片 JSON）
    const raw = events
      .filter((e): e is Extract<StreamEvent, { type: 'tool_call_delta' }> => e.type === 'tool_call_delta')
      .map((e) => e.argsDelta)
      .join('');
    expect(JSON.parse(raw)).toEqual({ expression: '1+1' });
  });

  it('fail 回合：在产出事件前抛出，错误码保留', async () => {
    const provider = new FakeProvider({
      script: [{ fail: { code: 'rate_limit_error', message: '限流了' } }],
    });
    await expect(provider.complete(REQ)).rejects.toMatchObject({
      code: 'rate_limit_error',
      retryable: true,
    });
  });

  it('complete 与 stream 行为一致（complete 复用流组装）', async () => {
    const script = [{ text: '一致性' }] as const;
    const viaComplete = await new FakeProvider({ script }).complete(REQ);
    const viaStream = await new FakeProvider({ script }).complete(REQ);
    expect(viaComplete.message).toEqual(viaStream.message);
    expect(viaComplete.stopReason).toBe('end_turn');
  });

  it('countTokens：空串为 0；中英混排单调递增', () => {
    const provider = new FakeProvider({ script: [] });
    expect(provider.countTokens('')).toBe(0);
    const a = provider.countTokens('hello');
    const b = provider.countTokens('hello world');
    const c = provider.countTokens('hello world 你好世界');
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it('aborted signal → AbortError（协作式取消的传播路径）', async () => {
    const provider = new FakeProvider({ script: [{ text: '很长的回复内容' }], chunkSize: 1 });
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.complete({ ...REQ, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
