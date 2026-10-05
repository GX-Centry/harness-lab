/**
 * LLM 重试包装 —— 把「暂时性故障」变成对上层透明的一次成功调用。
 *
 * 设计要点：
 *
 * 1. **只重试可重试错误**：判定完全交给错误体系（isRetryableCode）——
 *    provider_error / rate_limit_error / timeout_error 重试；
 *    输入类、权限类、配置类错误立即冒泡（重试八百次也没用）。
 *
 * 2. **指数退避 + 抖动**：第 n 次失败的等待 = base * 2^(n-1)，封顶 maxDelay，
 *    再乘 ±25% 的随机抖动（防「惊群」：大批客户端同时重试会再次打爆服务）。
 *    公式独立导出（computeRetryDelay），测试可对具体数值断言。
 *
 * 3. **stream 不自动重试——这是刻意的**：
 *    流一旦产出了部分事件（文本已渲染给用户），重试会重复输出，
 *    而「回滚已渲染内容」是 UI 层的职责，llm 层没有这个信息。
 *    正确位置是 Loop 层的「整轮重试」（它知道哪些状态需要回滚）。
 *    所以这里 stream 原样透传；未来若做整轮重试，也在上层实现。
 *
 * 4. **依赖注入保证可测性**：sleep / random / onRetry 全部可注入——
 *    测试里注入即时 sleep 与固定 random，重试逻辑完全可以断言（确定性优先）。
 *
 * 依赖方向：llm/retry.ts → config.ts（RetryConfig）/ errors.ts / types.ts。
 */

import type { RetryConfig } from '../config.ts';
import { toHarnessError } from '../errors.ts';
import type { HarnessErrorCode } from '../errors.ts';
import type { LLMProvider, LLMRequest, LLMResponse } from '../types.ts';

// ===========================================================================
// §1 可注入依赖
// ===========================================================================

/** 重试事件信息（装配层把它转成 llm_retry 事件） */
export interface RetryEventInfo {
  /** 第几次尝试失败（1-based）：attempt=2 表示首次失败后正在准备第二次 */
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly code: HarnessErrorCode;
  /** 本次重试前的实际等待毫秒数（含抖动后） */
  readonly delayMs: number;
  readonly message: string;
}

export interface RetryDeps {
  /** 注入 sleep（默认 setTimeout）：测试注入即时实现 → 零等待 */
  readonly sleep?: (ms: number) => Promise<void>;
  /** 注入随机源（默认 Math.random）：测试注入固定值 → 抖动可预测 */
  readonly random?: () => number;
  /** 重试回调：每次决定重试时调用（用于事件上报） */
  readonly onRetry?: (info: RetryEventInfo) => void;
}

/** 默认 sleep 实现（共享给 FakeProvider 等需要「时间注入」的模块） */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ===========================================================================
// §2 退避计算（独立导出，接受数值断言）
// ===========================================================================

/**
 * 计算第 failedAttempt 次失败后的等待时长。
 *   nominal = min(maxDelay, base * 2^(failedAttempt-1))   ← 指数退避
 *   delay   = round(nominal * (0.75 + random()*0.5))      ← ±25% 抖动
 */
export function computeRetryDelay(retry: RetryConfig, failedAttempt: number, random: () => number): number {
  const nominal = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (failedAttempt - 1));
  const jitter = 0.75 + random() * 0.5;
  return Math.round(nominal * jitter);
}

// ===========================================================================
// §3 包装器
// ===========================================================================

/**
 * 把任意 Provider 包成「带 complete 重试」的 Provider（装饰器模式）。
 * 名称叠加（'fake:retry'）便于事件与日志区分包装层。
 */
export function withRetry(provider: LLMProvider, retry: RetryConfig, deps: RetryDeps = {}): LLMProvider {
  const doSleep = deps.sleep ?? sleep;
  const random = deps.random ?? Math.random;

  return {
    name: `${provider.name}:retry`,

    async complete(req: LLMRequest): Promise<LLMResponse> {
      // 无限 for + 内部 return/throw：让「所有路径要么返回要么抛出」在结构上成立
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await provider.complete(req);
        } catch (raw) {
          const error = toHarnessError(raw, 'llm/retry');
          // 停试的三种情况：不可重试 / 次数用尽 / 已被取消
          if (!error.retryable || attempt >= retry.maxAttempts) throw error;
          if (req.signal?.aborted === true) throw error; // 用户已取消：不再等待与重试
          const delayMs = computeRetryDelay(retry, attempt, random);
          deps.onRetry?.({
            attempt,
            maxAttempts: retry.maxAttempts,
            code: error.code,
            delayMs,
            message: error.message,
          });
          await doSleep(delayMs);
        }
      }
    },

    /**
     * 流式不在此层重试（见文件头第 3 点）：原样透传。
     * 保留此分支是为了显式记录「这里考虑过、且刻意不做」。
     */
    stream: (req) => provider.stream(req),

    countTokens: (text) => provider.countTokens(text),
  };
}
