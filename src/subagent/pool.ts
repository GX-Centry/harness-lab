/**
 * 并发池（worker 模式）—— fan-out 的执行引擎。
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 为什么是「N 个 worker 抢任务」而不是「分批 Promise.allSettled」？     │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 *   分批模式：[t1 t2 t3 | t4 t5 t6]——若 t1 跑 10s、t2 t3 跑 1s，
 *             整批要等 t1，槽位空转（木桶效应）。
 *   worker 模式：3 个 worker 谁空谁取下一个——慢任务不堵别人的路，
 *             墙钟时间接近理论下界。实现只多一个共享游标。
 *
 * 为什么并发不破坏可断言性？
 *   输出**按输入顺序**归位（outcomes[index]），与完成顺序无关——
 *   测试可以对结果数组逐项断言，不受调度时序影响（确定性铁律）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 取消语义（与 fail-fast 哲学的分界）：
 *
 *   区分两类异常（借用 Dispatcher 的分类学）：
 *     - **AbortError** = 控制流：某个任务被取消 ⇒ 整个池已无意义
 *       （会话级取消通常同时作用于全部任务）⇒ 停止调度新任务、
 *       等已开工任务收敛、向上抛 AbortError。
 *     - **其余异常** = 数据：登记为 ok:false 的结果，**不影响其他任务**
 *       ——这就是 partial 语义（对照 w12 skill 的 fail-fast：
 *       技能步骤互相消费输出，一步失败后续无意义；fan-out 任务互相
 *       独立，一个失败不该株连其他）。
 *
 *   取消前提（显式标注）：任务函数必须**尊重传入的 AbortSignal**。
 *   池只能停止「调度」，无法终止「已在跑的僵尸任务」——若任务无视
 *   signal 永不返回，池的 await 会被永久阻塞。这不设防的缺口由
 *   上游保证（AgentTool 的子循环在轮次边界与流分片处都检查 signal，
 *   是全项目最彻底的取消消费者）。
 *
 *   超时为什么不在池级实现？（对照实验：池级 Promise.race 会留下
 *   僵尸任务 + 事件错位，正是 Dispatcher.executeWithTimeout 注释里
 *   的同一个坑。）超时属于**任务内部**的实现细节——AgentTool 用
 *   controller.abort() 做协作式取消，语义干净。
 *
 * 依赖方向：subagent/pool.ts → errors.ts（仅 isAbortError / HarnessError）。
 * 本文件与子代理领域**完全无关**（纯泛型调度）——它可以服务任何
 * 「有界并发的任务列表」，是通用件。
 */

import { HarnessError, isAbortError } from '../errors.ts';

// ===========================================================================
// §1 形状
// ===========================================================================

/** 池中执行的一个任务：零参异步函数（捕获所需上下文在闭包里） */
export type PoolTaskFn<T> = () => Promise<T>;

/** 单个任务的结算（判别联合：ok 决定 value / error 的存在性） */
export type PoolOutcome<T> =
  | { readonly index: number; readonly ok: true; readonly value: T }
  | { readonly index: number; readonly ok: false; readonly error: unknown };

export interface PoolOptions {
  /**
   * 并发度上限（同时执行的任务数）。
   * 实际 worker 数 = min(concurrency, 任务数)——任务少时不开空转 worker。
   */
  readonly concurrency: number;
}

// ===========================================================================
// §2 实现
// ===========================================================================

/**
 * 以有界并发执行任务列表。
 *
 * 契约（调用方可以依赖的全部）：
 *   1. 返回值与输入**同序**：outcomes[i] 对应 tasks[i]；
 *   2. 非取消的失败不中断池（结果里以 ok:false 呈现）；
 *   3. AbortError 中断调度并向上抛（抛的是任务原始异常，保留堆栈）；
 *   4. 同时执行的任务数 <= concurrency（测试断言并发峰值用）。
 */
export async function runWithConcurrency<T>(
  tasks: readonly PoolTaskFn<T>[],
  options: PoolOptions,
): Promise<readonly PoolOutcome<T>[]> {
  if (options.concurrency < 1) {
    throw new HarnessError('config_error', `并发池 concurrency 必须 >= 1，当前 ${options.concurrency}`, {
      where: 'subagent/pool',
    });
  }
  if (tasks.length === 0) return [];

  // 按位预分配：结果归位不依赖完成顺序（可断言性的来源）
  const outcomes: (PoolOutcome<T> | undefined)[] = new Array(tasks.length).fill(undefined);
  /** 共享游标：JS 单线程模型下「取号」是同步原子操作，无竞争 */
  let nextIndex = 0;
  /** 取消标志：任一任务抛 AbortError 即置位（停止调度，但不打断在跑者） */
  let aborted = false;
  let abortCause: unknown;

  const worker = async (): Promise<void> => {
    while (true) {
      if (aborted) return; // 取消：不再取新任务（在跑的任务各自收敛）
      const index = nextIndex;
      nextIndex += 1;
      if (index >= tasks.length) return; // 队列耗尽：正常退出

      const task = tasks[index];
      if (task === undefined) continue; // noUncheckedIndexedAccess 护栏（循环界内不可能）

      try {
        const value = await task();
        outcomes[index] = { index, ok: true, value };
      } catch (error) {
        if (isAbortError(error)) {
          // 取消是控制流：停止调度，已开工任务等其自然收敛后整体上抛
          aborted = true;
          abortCause = error;
          return;
        }
        // 普通失败：登记结果，不影响其他任务（partial 语义）
        outcomes[index] = { index, ok: false, error };
      }
    }
  };

  const workerCount = Math.min(options.concurrency, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (aborted) {
    // 取消路径：partial 结果不返回（调用方在执行取消时只关心「停了」。
    // 若要观察「取消时哪些已完成」——走事件流，不从返回值拿）。
    throw abortCause;
  }

  // 断言正确性：非取消路径下每个 index 都被某个 worker 写过一次
  //（nextIndex 的取号机制保证全覆盖，fill 只为内存形状）。
  return outcomes as ReadonlyArray<PoolOutcome<T>>;
}
