/**
 * runWithConcurrency 单元测试 —— 并发池的调度契约。
 *
 * 覆盖矩阵（对齐 pool.ts 文件头的四条契约）：
 *   ① 有界并发：同时执行数 <= concurrency（峰值断言）；
 *   ② 同序归位：结果按输入顺序排列，与完成顺序无关；
 *   ③ partial 语义：普通失败登记为 ok:false，不株连其他任务；
 *   ④ 取消传播：AbortError 停止调度（后续任务零执行）并向上抛；
 *   ⑤ 参数防呆：concurrency < 1 → config_error。
 *
 * 并发场景使用真实 setTimeout（毫秒级）：这是少数「真实时间不可避」的
 * 测试——并发调度本身就是时间现象。延迟一律取 1~2ms，总耗时可控。
 */

import { describe, expect, it } from 'vitest';
import { HarnessError } from '../../src/errors.ts';
import { runWithConcurrency } from '../../src/subagent/pool.ts';

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 真实等待（并发测试的最小代价——见文件头注释） */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortError(message = '取消'): DOMException {
  return new DOMException(message, 'AbortError');
}

// ---------------------------------------------------------------------------
// ① 有界并发与同序归位
// ---------------------------------------------------------------------------

describe('runWithConcurrency：并发与顺序', () => {
  it('同时执行的任务数不超过 concurrency（峰值断言）', async () => {
    let running = 0;
    let peak = 0;
    const total = 9;

    const tasks = Array.from({ length: total }, (_v, i) => async () => {
      running += 1;
      peak = Math.max(peak, running);
      await delay(2);
      running -= 1;
      return i;
    });

    const outcomes = await runWithConcurrency(tasks, { concurrency: 3 });

    expect(outcomes).toHaveLength(total);
    // 峰值必须恰好触到 3（9 个任务、2ms 延迟——worker 必然填满槽位），
    // 且永不超过 3：这就是「有界」的双向证据。
    expect(peak).toBe(3);
  });

  it('结果按输入顺序归位（与完成顺序无关）', async () => {
    // 第 0 个任务最慢、越往后越快——完成顺序与输入顺序完全相反
    const tasks = Array.from({ length: 4 }, (_v, i) => async () => {
      await delay((4 - i) * 2);
      return `v${i}`;
    });

    const outcomes = await runWithConcurrency(tasks, { concurrency: 4 });

    expect(outcomes.map((o) => (o.ok ? o.value : '?ERROR'))).toEqual(['v0', 'v1', 'v2', 'v3']);
    expect(outcomes.map((o) => o.index)).toEqual([0, 1, 2, 3]);
  });

  it('concurrency 大于任务数时不空转（正常完成）', async () => {
    const tasks = [async () => 1, async () => 2];
    const outcomes = await runWithConcurrency(tasks, { concurrency: 10 });
    expect(outcomes.map((o) => (o.ok ? o.value : '?'))).toEqual([1, 2]);
  });

  it('空任务列表直接返回空数组', async () => {
    expect(await runWithConcurrency([], { concurrency: 3 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ③ partial 语义
// ---------------------------------------------------------------------------

describe('runWithConcurrency：partial 语义', () => {
  it('普通失败登记为 ok:false，不影响其他任务（原始错误保留）', async () => {
    const boom = new Error('任务 1 炸了');
    const tasks = [
      async () => 'ok-0',
      async () => {
        throw boom;
      },
      async () => 'ok-2',
    ];

    const outcomes = await runWithConcurrency(tasks, { concurrency: 3 });

    expect(outcomes[0]?.ok).toBe(true);
    expect(outcomes[1]?.ok).toBe(false);
    if (outcomes[1]?.ok === false) {
      expect(outcomes[1].error).toBe(boom); // 原始对象原样保留（保留堆栈与 cause 链）
    }
    expect(outcomes[2]?.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ④ 取消传播
// ---------------------------------------------------------------------------

describe('runWithConcurrency：取消传播', () => {
  it('AbortError 停止调度：后续任务零执行，整体抛取消', async () => {
    const executed: number[] = [];
    // 串行（concurrency=1）让调度行为完全确定：取号 → 执行 → 取号 → ...
    const tasks = Array.from({ length: 8 }, (_v, i) => async () => {
      executed.push(i);
      if (i === 2) throw abortError('第 3 个任务触发取消');
      return i;
    });

    let caught: unknown;
    try {
      await runWithConcurrency(tasks, { concurrency: 1 });
    } catch (error) {
      caught = error;
    }

    // 任务 0、1 完成，任务 2 触发取消——2 之后的任务一个都没有被执行
    expect(executed).toEqual([0, 1, 2]);
    expect(caught).toBeInstanceOf(DOMException);
    expect((caught as DOMException).name).toBe('AbortError');
    expect((caught as DOMException).message).toBe('第 3 个任务触发取消'); // 原始取消原因穿透
  });

  it('并发场景下取消：已开工任务收敛后才上抛（调度停止但不等新任务）', async () => {
    const executed: number[] = [];
    const tasks = Array.from({ length: 6 }, (_v, i) => async () => {
      executed.push(i);
      await delay(2);
      if (i === 0) throw abortError(); // 最快的 worker 先触发
      return i;
    });

    let caught: unknown;
    try {
      await runWithConcurrency(tasks, { concurrency: 2 });
    } catch (error) {
      caught = error;
    }

    // 取消前最多执行了「在途」的任务（2 个槽位 + 可能的取号竞态窗口），
    // 但绝不会执行完 6 个——断言上界即可（下界依赖时序，不做断言）
    expect(executed.length).toBeLessThanOrEqual(3);
    expect(caught).toBeInstanceOf(DOMException);
    expect((caught as DOMException).name).toBe('AbortError');
  });
});

// ---------------------------------------------------------------------------
// ⑤ 参数防呆
// ---------------------------------------------------------------------------

describe('runWithConcurrency：参数防呆', () => {
  it('concurrency < 1 抛 config_error（启动期防呆）', async () => {
    const tasks = [async () => 1];
    await expect(runWithConcurrency(tasks, { concurrency: 0 })).rejects.toThrow(HarnessError);
    await expect(runWithConcurrency(tasks, { concurrency: 0 })).rejects.toThrow(/concurrency 必须/);
  });
});
