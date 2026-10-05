/**
 * 会话域场景 —— 跨进程恢复的两条路径（Session Rig 专属——见 session-rig.ts）。
 *
 * 「崩溃现场」的构造方式：session 预置把消息/状态/检查点写入临时 SQLite
 * 并重开连接（跨进程语义），run 时按状态门控决定是否走恢复流程。
 *
 * 两条路径的分工（状态门控的正反面）：
 *   session-resume-fill       ← interrupted/processing → resumeSession：
 *     2 个未完成调用被补位（精确 2 个）、僵尸态修正、补位文案进入上下文；
 *   session-restart-continue  ← completed → 不做恢复：
 *     旧历史原样加载进新 query（负路径：resume 必须为 undefined）。
 *
 * 断言读法：resume 报告（补位数量/触发与否）+ persistedMessages（配对
 * 完整性/历史连续性）+ 上下文（补位文案真的到了模型眼前）。
 *
 * 依赖方向：scenarios/session.ts → src/eval（断言与类型）+ session/checkpoint
 * （补位文案常量）+ 全局消息工厂。
 */

import type { EvalScenario } from '../src/eval/index.ts';
import {
  assertContextContains,
  assertResumeFilled,
  assertSessionState,
  assertStopReason,
} from '../src/eval/index.ts';
import type { FakeTurn } from '../src/llm/fake-provider.ts';
import { INTERRUPTED_TOOL_REASON } from '../src/session/checkpoint.ts';
import { assistantMessage, userMessage } from '../src/types.ts';
import type { ToolCall } from '../src/types.ts';

// ===========================================================================
// §1 崩溃现场装置
// ===========================================================================

/**
 * 崩溃时刻「已宣布但无结果」的两个工具调用——配对的半截。
 * 用固定 id（fc_crash_N）让补位断言可与具体调用对应（不是只数数量）。
 */
const CRASH_CALLS: readonly ToolCall[] = [
  { id: 'fc_crash_0', name: 'calculator', args: { expression: '1 + 1' }, argsRaw: '{"expression":"1 + 1"}' },
  { id: 'fc_crash_1', name: 'calculator', args: { expression: '2 + 2' }, argsRaw: '{"expression":"2 + 2"}' },
];

/** 恢复后的续问剧本：重算一个数再作答（恢复正常路径的行为基线） */
const RESUME_FILL_SCRIPT: readonly FakeTurn[] = [
  { text: '我重新算 5 * 5。', toolCalls: [{ name: 'calculator', args: { expression: '5 * 5' } }] },
  { text: '5 * 5 = 25。另外两个计算的结果已丢失，可以重新问我。' },
];

/** 续问剧本：普通一问一答（历史加载 + 新 query） */
const RESTART_CONTINUE_SCRIPT: readonly FakeTurn[] = [
  { text: '我算一下。', toolCalls: [{ name: 'calculator', args: { expression: '1 + 1' } }] },
  { text: '等于 2。' },
];

// ===========================================================================
// §2 场景
// ===========================================================================

export function createSessionScenarios(): readonly EvalScenario[] {
  return [
    // -----------------------------------------------------------------------
    // session-resume-fill：硬崩溃现场——进程在工具执行中途被杀，
    // assistant 宣布了 2 个调用但结果未落盘；DB 里状态停留在 'processing'
    // （僵尸态：内存无 running 记录 → 判定为崩溃残留）。
    // 恢复路径：resumeSession 补位 2 条 → 僵尸态修正 interrupted →
    // runQuery 加载「完整」历史续问 → 终态 completed。
    // 断言读法：
    //   - 补位精确 2 个（多补/少补都是 bug）；
    //   - 补位文案进入上下文（模型看得到「结果已丢失」的说明）；
    //   - 落盘历史配对完整（每个 toolCall 有结果——恢复的核心不变量）。
    // -----------------------------------------------------------------------
    {
      name: 'session-resume-fill',
      description: '会话恢复：崩溃残留的 2 个未完成调用被补位，僵尸态修正后完成',
      input: '刚才中断了。请重新计算 5 * 5 并回答',
      script: RESUME_FILL_SCRIPT,
      session: {
        messages: [
          userMessage('请依次计算 1 + 1 与 2 + 2'),
          assistantMessage('好，我分两步算。', CRASH_CALLS),
          // 两个 tool 结果都缺失——进程在工具执行中途被杀
        ],
        state: 'processing', // 崩溃残留（僵尸态——恢复流程中最需要处理的现场）
        checkpointTurn: 1,
      },
      assertions: [
        assertResumeFilled(2), // 精确补位 2 个
        assertSessionState('completed'),
        assertStopReason('completed'),
        assertContextContains({ text: INTERRUPTED_TOOL_REASON, role: 'tool' }),
        {
          name: '落盘历史配对完整：每个 toolCall 都有对应 tool 结果',
          check: (evidence) => {
            const session = evidence.session;
            if (session === undefined) return '未使用 Session Rig（无会话面证据）';
            const answered = new Set<string>();
            for (const message of session.persistedMessages) {
              if (message.role === 'tool') answered.add(message.toolCallId);
            }
            const missing: string[] = [];
            for (const message of session.persistedMessages) {
              if (message.role !== 'assistant') continue;
              for (const call of message.toolCalls ?? []) {
                if (!answered.has(call.id)) missing.push(call.id);
              }
            }
            if (missing.length === 0) return undefined;
            return `以下工具调用没有配对结果：${missing.join(', ')}`;
          },
        },
      ],
    },

    // -----------------------------------------------------------------------
    // session-restart-continue：优雅结束后重启——状态 'completed'，
    // 没有半截调用。状态门控的负路径：**不触发** resumeSession
    // （completed 直接以新 query 继续），旧历史原样加载进新上下文。
    // 断言读法：
    //   - resume === undefined（负路径：恢复专指 checkpoint 路径）；
    //   - 旧 user 消息（「苹果」）出现在请求上下文（历史被加载而非重置）；
    //   - 落盘消息数增长且首条保留（历史连续性）。
    // -----------------------------------------------------------------------
    {
      name: 'session-restart-continue',
      description: '会话续问：completed 状态直接以新 query 继续（不触发恢复流程）',
      input: '再问一句：1 + 1 等于几？',
      script: RESTART_CONTINUE_SCRIPT,
      session: {
        messages: [
          userMessage('你好'),
          assistantMessage('你好！有什么可以帮你？'),
          userMessage('记住一个词：苹果'),
          assistantMessage('记住了：苹果。'),
        ],
        state: 'completed',
      },
      assertions: [
        assertStopReason('completed'),
        assertSessionState('completed'),
        assertContextContains({ text: '苹果', role: 'user' }), // 旧历史进入新 query 上下文
        {
          name: '未触发恢复流程（state=completed → 直接续问）',
          check: (evidence) => {
            const session = evidence.session;
            if (session === undefined) return '未使用 Session Rig（无会话面证据）';
            if (session.resume === undefined) return undefined;
            return `不该触发恢复，但 resumeSession 返回了 checkpoint ${session.resume.checkpointId}`;
          },
        },
        {
          name: '历史连续性：预置 4 条保留且新消息追加在后',
          check: (evidence) => {
            const session = evidence.session;
            if (session === undefined) return '未使用 Session Rig（无会话面证据）';
            const persisted = session.persistedMessages;
            if (persisted.length <= 4) {
              return `期望 > 4 条持久化消息（4 条预置 + 本轮新增），实际 ${persisted.length} 条`;
            }
            const first = persisted[0];
            if (first === undefined || first.role !== 'user' || first.content !== '你好') {
              const actual =
                first === undefined ? '（空历史）' : `${first.role}: ${first.content.slice(0, 30)}`;
              return `首条消息应为预置的「你好」，实际 ${actual}`;
            }
            return undefined;
          },
        },
      ],
    },
  ];
}
