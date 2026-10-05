/**
 * 重试包装器单元测试（确定性优先的范例：注入 sleep 与 random 后，
 * 「等待多久、重试几次、什么错误不重试」全部可以对具体数值断言）。
 */

import { describe, expect, it } from 'vitest';
import { FakeProvider } from '../../src/llm/fake-provider.ts';
import { computeRetryDelay, withRetry } from '../../src/llm/retry.ts';
import type { RetryEventInfo } from '../../src/llm/retry.ts';

const REQ = { model: 'test', messages: [{ role: 'user' as const, content: 'hi' }] };
const RETRY = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 8000 } as const;

/** 注入即时 sleep 并记录等待时长 */
function makeDeps(): {
  deps: { sleep: (ms: number) => Promise<void>; random: () => number; onRetry: (i: RetryEventInfo) => void };
  slept: number[];
  retries: RetryEventInfo[];
} {
  const slept: number[] = [];
  const retries: RetryEventInfo[] = [];
  return {
    slept,
    retries,
    deps: {
      sleep: (ms: number) => {
        slept.push(ms);
        return Promise.resolve();
      },
      random: () => 0.5, // jitter = 0.75 + 0.5*0.5 = 1.0 → delay 恰为名义退避值
      onRetry: (info: RetryEventInfo) => retries.push(info),
    },
  };
}

describe('computeRetryDelay', () => {
  it('指数退避：500 → 1000 → 2000，并在 maxDelay 处封顶', () => {
    const r = () => 0.5; // 抖动因子恰为 1.0
    expect(computeRetryDelay(RETRY, 1, r)).toBe(500);
    expect(computeRetryDelay(RETRY, 2, r)).toBe(1000);
    expect(computeRetryDelay(RETRY, 3, r)).toBe(2000);
    expect(computeRetryDelay(RETRY, 10, r)).toBe(8000); // 封顶
  });

  it('抖动范围：random 极值时在 ±25% 内', () => {
    expect(computeRetryDelay(RETRY, 1, () => 0)).toBe(375); // 500 * 0.75
    expect(computeRetryDelay(RETRY, 1, () => 1)).toBe(625); // 500 * 1.25
  });
});

describe('withRetry', () => {
  it('首次失败后可重试错误 → 重试成功，onRetry 与 sleep 记录正确', async () => {
    const provider = new FakeProvider({
      script: [{ fail: { code: 'provider_error', message: '暂时不可用' } }, { text: '成功' }],
    });
    const { deps, slept, retries } = makeDeps();
    const wrapped = withRetry(provider, RETRY, deps);
    const result = await wrapped.complete(REQ);
    expect(result.message.content).toBe('成功');
    expect(provider.consumedTurns).toBe(2); // 消耗了两轮脚本
    expect(slept).toEqual([500]); // 第一次失败后等 500ms（名义值 * 1.0）
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ attempt: 1, maxAttempts: 3, code: 'provider_error', delayMs: 500 });
  });

  it('不可重试错误（input_error）→ 立即抛出，不等待不重试', async () => {
    const provider = new FakeProvider({
      script: [{ fail: { code: 'input_error', message: '参数错了' } }],
    });
    const { deps, slept, retries } = makeDeps();
    await expect(withRetry(provider, RETRY, deps).complete(REQ)).rejects.toMatchObject({
      code: 'input_error',
    });
    expect(slept).toEqual([]);
    expect(retries).toEqual([]);
    expect(provider.consumedTurns).toBe(1);
  });

  it('重试次数用尽 → 抛最后一次错误（共尝试 maxAttempts 次）', async () => {
    const provider = new FakeProvider({
      script: [
        { fail: { code: 'timeout_error', message: '超时1' } },
        { fail: { code: 'timeout_error', message: '超时2' } },
        { fail: { code: 'timeout_error', message: '超时3' } },
      ],
    });
    const { deps, slept } = makeDeps();
    await expect(withRetry(provider, RETRY, deps).complete(REQ)).rejects.toMatchObject({
      code: 'timeout_error',
      message: '超时3',
    });
    expect(provider.consumedTurns).toBe(3);
    expect(slept).toEqual([500, 1000]); // 前两次失败后各等待一次；第三次失败直接抛
  });

  it('stream 不在此层重试：失败直接冒泡，一次都不重试', async () => {
    const provider = new FakeProvider({
      script: [{ fail: { code: 'provider_error', message: '流式失败' } }, { text: '本应不被消费' }],
    });
    const { deps, retries } = makeDeps();
    const wrapped = withRetry(provider, RETRY, deps);
    await expect(
      (async () => {
        for await (const _ of wrapped.stream(REQ)) {
          // 不产出任何事件
        }
      })(),
    ).rejects.toMatchObject({ code: 'provider_error' });
    expect(provider.consumedTurns).toBe(1);
    expect(retries).toEqual([]);
  });

  it('signal 已取消 → 不进入重试等待（取消优先级最高）', async () => {
    const provider = new FakeProvider({
      script: [{ fail: { code: 'provider_error', message: 'x' } }, { text: '不应到达' }],
    });
    const { deps, slept } = makeDeps();
    const controller = new AbortController();
    controller.abort();
    await expect(
      withRetry(provider, RETRY, deps).complete({ ...REQ, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'provider_error' });
    expect(slept).toEqual([]);
    expect(provider.consumedTurns).toBe(1);
  });

  it('包装后的 name 叠加（事件与日志可区分包装层）', () => {
    const provider = new FakeProvider({ script: [] });
    expect(withRetry(provider, RETRY).name).toBe('fake:retry');
  });
});
