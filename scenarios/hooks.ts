/**
 * Hook 域场景 —— 管道三大「改写能力」的行为化验证。
 *
 * 三个场景各锚定 HookOutcome 的一个非平凡 kind（判决即数据）：
 *   hook-modify-input   ← modify_input：参数替换后被真实执行消费
 *   hook-block-repeat   ← block：熔断拦截，拒绝结果注入对话
 *   hook-modify-result  ← modify_result：默认 truncate-result 改写超长结果
 * （continue / skip 是流程内部细节，不作为断言对象——断言「判决产生且
 *   被消费」，而不是「管道跑过了」。）
 *
 * 断言读法：hook_outcome 事件（hook 说了什么）+ 下游证据（上下文/工具
 * 结果真的变了）双证——单看事件只证明判决，双证才是「世界变了」。
 *
 * 依赖方向：scenarios/hooks.ts → src/eval（断言与类型）+ 全局 Hook 类型。
 */

import type { EvalScenario } from '../src/eval/index.ts';
import {
  assertContextContains,
  assertHookOutcome,
  assertStopReason,
  assertToolErrorCode,
  assertToolSequence,
} from '../src/eval/index.ts';
import type { Hook } from '../src/types.ts';

// ===========================================================================
// §1 共享装置
// ===========================================================================

/**
 * 场景私有 hook：把 echo 的 message 参数改写为大写（modify_input 最小演示）。
 * priority 50 排在默认 repeat-guard(40) 之后——先让熔断看原始签名，
 * 改写属于「最后加工」（与 post 链里 truncate 后置同理）。
 */
function createUppercaseEchoHook(): Hook {
  return {
    name: 'uppercase-echo',
    priority: 50,
    events: ['tool_call_before'],
    async handler(payload) {
      if (payload.toolCall?.name !== 'echo') return { kind: 'continue' };
      const input = payload.input as { message?: unknown } | undefined;
      if (typeof input?.message !== 'string') return { kind: 'continue' };
      return { kind: 'modify_input', input: { ...input, message: input.message.toUpperCase() } };
    },
  };
}

// ===========================================================================
// §2 场景
// ===========================================================================

export function createHookScenarios(): readonly EvalScenario[] {
  return [
    // -----------------------------------------------------------------------
    // hook-modify-input：自定义 hook 把参数改写成大写，echo 执行的是改写后
    // 的参数。双证 = hook_outcome(modify_input) + 上下文里 tool 结果为大写
    // （「HELLO WORLD」是 Harness 契约文本——执行消费的证据，不是模型发挥）。
    // -----------------------------------------------------------------------
    {
      name: 'hook-modify-input',
      description: 'hook 改写输入：uppercase-echo 替换参数后被真实执行消费（双证）',
      input: '请回显 hello world',
      script: [
        { text: '我回显。', toolCalls: [{ name: 'echo', args: { message: 'hello world' } }] },
        { text: '完成。' },
      ],
      hooks: [createUppercaseEchoHook()],
      assertions: [
        assertStopReason('completed'),
        assertHookOutcome({ hook: 'uppercase-echo', kind: 'modify_input' }),
        assertContextContains({ text: 'HELLO WORLD', role: 'tool' }),
      ],
    },

    // -----------------------------------------------------------------------
    // hook-block-repeat：模型连续 3 次调用同一工具 + 相同参数（A A A 模式）。
    // repeat-guard（默认集，priority 40）在第 3 次触发熔断。
    // 两个事件面的语义对照（本场景的教学点）：
    //   - LoopEvent.tool_started（尝试面）：模型「发起」调用即发出——3 次
    //     （面向用户的对话流：「模型试图调用 X」）；
    //   - HarnessEvent.tool_started（执行面）：Dispatcher 在真正进入执行前
    //     才发出——只有 2 次（被 block 的第 3 次没有它，拦截 = 未进入执行）。
    // -----------------------------------------------------------------------
    {
      name: 'hook-block-repeat',
      description: 'hook 熔断：连续 3 次相同调用被 repeat-guard 拦截并转成拒绝结果',
      input: '请连续计算 1 + 1（验证熔断器）',
      script: [
        { text: '第一次计算。', toolCalls: [{ name: 'calculator', args: { expression: '1 + 1' } }] },
        { text: '再算一次。', toolCalls: [{ name: 'calculator', args: { expression: '1 + 1' } }] },
        { text: '再算一次。', toolCalls: [{ name: 'calculator', args: { expression: '1 + 1' } }] },
        { text: '重复调用被熔断拦下了——答案是 2。' },
      ],
      assertions: [
        assertStopReason('completed'),
        // 尝试面：模型发起了 3 次调用（被拦的那次也是「发起过的」）
        assertToolSequence(['calculator', 'calculator', 'calculator']),
        // 执行面：只有前两次真正进入执行——被拦的调用没有执行面 tool_started
        {
          name: '执行面 tool_started = 2 次（第 3 次被拦在执行前）',
          check: (evidence) => {
            const executed = evidence.events.filter(
              (event) => event.type === 'tool_started' && event.name === 'calculator',
            ).length;
            if (executed === 2) return undefined;
            return `期望执行面 2 次（前两次真正执行），实际 ${executed} 次`;
          },
        },
        assertHookOutcome({ hook: 'repeat-guard', kind: 'block' }),
        // block 转成的拒绝结果真实注入对话（ADR-005：拒绝是「对话的一部分」）
        assertToolErrorCode({ tool: 'calculator', code: 'permission_denied' }),
      ],
    },

    // -----------------------------------------------------------------------
    // hook-modify-result：echo 回显 5000 字符（超过 truncate-result 的
    // 默认 maxChars=4000），结果在入库前被截断（保留头尾 + 省略标记）。
    // 装置细节：overrides 把工具输出 token 上限抬到 5000（5000 字符 ≈
    // 1250 tok），排除 Context 层 L1 截断的干扰——truncate hook 成为唯一
    // 改写变量。内联断言验证「长度契约」：标记存在 + 长度低于 4000。
    // -----------------------------------------------------------------------
    {
      name: 'hook-modify-result',
      description: 'hook 改写结果：默认 truncate-result 截断超长工具输出后入库',
      input: '请把这段长文本原样回显',
      script: [
        { text: '回显中……', toolCalls: [{ name: 'echo', args: { message: 'z'.repeat(5000) } }] },
        { text: '完成。' },
      ],
      overrides: { context: { toolOutputMaxTokens: 5000 } },
      assertions: [
        assertStopReason('completed'),
        assertHookOutcome({ hook: 'truncate-result', kind: 'modify_result' }),
        {
          name: '上下文中的长结果已截断（含省略标记且长度低于 4000）',
          check: (evidence) => {
            const toolMessages = evidence.requests
              .flatMap((request) => request.messages)
              .filter((message) => message.role === 'tool');
            const truncated = toolMessages.find((message) => message.content.includes('[已省略'));
            if (truncated === undefined) {
              return `未找到含截断标记的 tool 消息（共 ${toolMessages.length} 条——改写未进入上下文？）`;
            }
            if (truncated.content.length >= 4000) {
              return `截断后长度 ${truncated.content.length} 仍 ≥ 4000（truncate-result 的 maxChars）`;
            }
            return undefined;
          },
        },
      ],
    },
  ];
}
