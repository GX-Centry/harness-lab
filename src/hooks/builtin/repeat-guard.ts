/**
 * repeat-guard hook —— 重复调用熔断（ADR-005 的兜底机制）。
 *
 * 背景：权限拒绝是「对话的一部分」——模型被拒后可能换路，也可能反复
 * 尝试同一操作。熔断器检测「同一工具 + 相同参数」的连续重复调用，
 * 达到阈值时 block（Dispatcher 会把它转成给模型的拒绝结果）。
 *
 * 语义细节（都经过刻意设计）：
 *   - 「连续」：与上一次调用签名相同才累计；不同签名重置计数。
 *     A A A → 第 3 次熔断；A B A B → 永不熔断（是探索不是死循环）；
 *   - 签名用 stableStringify(args)：键序无关，防止模型改写键序绕过检测；
 *   - 实例状态（lastSignature/streak）：hook 可以有状态，但状态的作用域
 *     由装配层控制——每个会话新建 pipeline 实例即天然隔离。
 *
 * priority = 40：放在 pre 阶段靠前的位置（审计类 hook 在 post 阶段，互不干扰），
 * 先于其他 pre-hook 执行，尽早拦截无意义的重复。
 */

import type { Hook, ToolCall } from '../../types.ts';
import { stableStringify } from './shared.ts';

export interface RepeatGuardOptions {
  /** 熔断阈值：连续第 N 次相同调用时 block（默认 3，对齐 config.hooks.repeatCallThreshold） */
  readonly threshold?: number;
}

export function createRepeatGuardHook(options: RepeatGuardOptions = {}): Hook {
  const threshold = options.threshold ?? 3;
  // hook 实例状态：随 pipeline 生命周期存在（装配层负责会话隔离）
  let lastSignature: string | undefined;
  let streak = 0;

  return {
    name: 'repeat-guard',
    priority: 40,
    events: ['tool_call_before'],
    async handler(payload) {
      const signature = signatureOf(payload.toolCall);
      if (signature === lastSignature) {
        streak += 1;
      } else {
        lastSignature = signature;
        streak = 1;
      }
      if (streak >= threshold) {
        return {
          kind: 'block',
          reason:
            `检测到重复调用熔断：同一工具与参数已连续出现 ${streak} 次（阈值 ${threshold}）。` +
            '请改用不同的参数或换一种方式完成任务。',
        };
      }
      return { kind: 'continue' };
    },
  };
}

/** 调用签名：工具名 + 稳定序列化参数（parseError 时退回原始文本） */
function signatureOf(call: ToolCall | undefined): string {
  if (call === undefined) return '';
  const argsPart = call.args !== undefined ? stableStringify(call.args) : call.argsRaw;
  return `${call.name}::${argsPart}`;
}
