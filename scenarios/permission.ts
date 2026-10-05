/**
 * 权限域场景 —— 显式规则覆盖 fail-safe 缺省的「正向路径」。
 *
 * 与内置 S2（permission-fail-safe）的对照设计：
 *   S2 ：无规则 + 无确认通道 → medium 风险调用被 fail-safe 拒绝（负向路径）；
 *   本域：显式 allow 规则命中 → 同一形态的调用被放行、子代理真实执行
 *         （正向路径——注意本场景同样没有确认通道，放行完全来自规则优先级）。
 *   两个场景并读 = 「规则命中 > 风险策略缺省」的决策顺序全貌（见 rules.ts）。
 *
 * 断言读法：permission_decision 事件的 decision 字段是断言对象——
 * 「为什么放行」（reason）与「结果是什么」都在事件里，决策链可追溯。
 *
 * 依赖方向：scenarios/permission.ts → src/eval（断言与类型）+ 模块公开类型。
 */

import type { EvalScenario } from '../src/eval/index.ts';
import {
  assertStopReason,
  assertSubagentRan,
  assertToolSequence,
} from '../src/eval/index.ts';
import type { HarnessEvent } from '../src/kernel/events.ts';
import type { FakeTurn } from '../src/llm/fake-provider.ts';
import type { SubAgentDefinition } from '../src/subagent/types.ts';

// ===========================================================================
// §1 共享装置（本域自持——场景文件独立可读优先于跨文件 DRY）
// ===========================================================================

/** 研究员子代理（受控演示形态：可计算、边界清晰） */
const RESEARCHER: SubAgentDefinition = {
  name: 'researcher',
  description: '资料调研子代理（受控演示：calculator 可用）',
  systemPrompt: '你是资料研究员。完成指派任务后，用一句话给出结论。',
  toolNames: ['calculator'],
  maxTurns: 3,
};

/** 研究员剧本：算一次再给结论（子世界完整 2 轮） */
const RESEARCHER_SCRIPT: readonly FakeTurn[] = [
  { text: '我来计算。', toolCalls: [{ name: 'calculator', args: { expression: '21 * 2' } }] },
  { text: '结论：21 * 2 = 42。' },
];

// ===========================================================================
// §2 场景
// ===========================================================================

export function createPermissionScenarios(): readonly EvalScenario[] {
  return [
    // -----------------------------------------------------------------------
    // permission-rule-allow：规则表命中 → 直接放行。
    // 断言读法：
    //   - 子代理真实运行过（S2 里同款调用被拦下、从未执行——正反对照）；
    //   - permission_decision 事件的 decision=allow（决策链被观测）；
    //   - 主世界工具序列 = [researcher]（没有重试或多余调用）。
    // -----------------------------------------------------------------------
    {
      name: 'permission-rule-allow',
      description: '权限规则：显式 allow 覆盖 fail-safe 缺省（对照 S2 的拒绝路径）',
      input: '派研究员计算 21 * 2',
      script: [
        {
          text: '我派研究员去算。',
          toolCalls: [{ name: 'researcher', args: { task: '计算 21 * 2 并给出一句话结论' } }],
        },
        { text: '收到结论：42。' },
      ],
      subagents: [RESEARCHER],
      subagentScripts: { researcher: RESEARCHER_SCRIPT },
      // 关键装置：规则表显式放行 researcher。注意本场景**没有**确认通道
      // （autoApprovePermissions 缺省 false）——放行完全来自规则优先级。
      permissionRules: [
        {
          match: 'researcher',
          decision: 'allow',
          reason: '评测场景：researcher 为受控演示子代理，显式放行',
        },
      ],
      assertions: [
        assertStopReason('completed'),
        assertToolSequence(['researcher']),
        assertSubagentRan('researcher'), // 真实执行过（S2 中它被拦下，从未运行）
        {
          name: '权限决策 = allow（决策链：命中规则 → 直接放行）',
          check: (evidence) => {
            const decision = evidence.events.find(
              (event): event is Extract<HarnessEvent, { type: 'permission_decision' }> =>
                event.type === 'permission_decision' && event.toolName === 'researcher',
            );
            if (decision === undefined) {
              return '未找到 researcher 的 permission_decision 事件（决策链未被观测）';
            }
            if (decision.decision !== 'allow') {
              return `期望 allow（规则命中），实际 ${decision.decision}（reason: ${decision.reason}）`;
            }
            return undefined;
          },
        },
      ],
    },
  ];
}
