/**
 * 内置基准场景 —— 四个「冒烟级」行为断言的完整示例。
 *
 * 它们同时扮演三个角色：
 *   1. 协议的最佳示例（怎么写剧本、怎么配断言——照抄即可写新场景）；
 *   2. `pnpm lab` 幕 H 的演示素材（人读输出）；
 *   3. w18 场景测试层的种子（届时可能整体迁入 tests/scenarios/，
 *      本文件保留为「可编程的基准集」）。
 *
 * 场景与验证的机制对照（每个场景锚定一个已实现的模块能力）：
 *   S1 basic-tool-loop       ← w07/w08：四步链 + Loop 闭环
 *   S2 permission-fail-safe  ← w07：无确认通道的 fail-safe 拒绝（ADR-005 反向）
 *   S3 subagent-roundtrip    ← w13：Agent-as-Tool + w14 成本归属（账本闭环）
 *   S4 context-compression   ← w09：L1 工具输出截断（压缩链启动）
 *
 * 刻意不覆盖的机制（留给 w18 场景层，理由：需要更复杂的装置）：
 *   - 取消路径（需要中途 abort 的注入装置）；
 *   - 记忆注入（需要 Session/Memory——Core Rig 不管这两个，见 rig.ts 分工）。
 *
 * 依赖方向：eval/builtin-scenarios.ts → assertions.ts + types（eval 内部）
 * + 模块公开类型（llm / subagent）。
 */

import type { FakeTurn } from '../llm/fake-provider.ts';
import type { SubAgentDefinition } from '../subagent/types.ts';
import {
  assertCostUnder,
  assertEventEmitted,
  assertStopReason,
  assertSubagentRan,
  assertToolErrorCode,
  assertToolSequence,
} from './assertions.ts';
import type { EvalScenario } from './types.ts';

// ===========================================================================
// §1 共享装置
// ===========================================================================

/** S2/S3 共用的研究员定义（对应 w13 集成测试里的同款装配） */
const RESEARCHER: SubAgentDefinition = {
  name: 'researcher',
  description: '资料调研子代理（可计算、可回显——适合边界清晰的窄任务）',
  systemPrompt: '你是资料研究员。专注完成派给你的单个任务，最后用一句话给出结论。',
  toolNames: ['calculator'],
  maxTurns: 3,
};

/** S3 的研究员剧本：真的算一次，再给结论（子世界里完整跑 2 轮） */
const RESEARCHER_SCRIPT: readonly FakeTurn[] = [
  {
    text: '我来计算。',
    toolCalls: [{ name: 'calculator', args: { expression: '21 * 2' } }],
  },
  { text: '结论：21 * 2 = 42。' },
];

// ===========================================================================
// §2 场景集
// ===========================================================================

export function createBuiltinScenarios(): readonly EvalScenario[] {
  return [
    // -----------------------------------------------------------------------
    // S1：最基础的闭环——模型调一次工具、拿到结果、作答。
    // 断言读法：终止原因必须是 completed（而不是 max_turns/budget），
    // 且主世界只调了 calculator（没有多余或缺失的调用）。
    // -----------------------------------------------------------------------
    {
      name: 'basic-tool-loop',
      description: '基础工具闭环：一次计算并作答',
      input: '请计算 21 * 2',
      script: [
        { text: '我先计算。', toolCalls: [{ name: 'calculator', args: { expression: '21 * 2' } }] },
        { text: '答案是 42。' },
      ],
      assertions: [assertStopReason('completed'), assertToolSequence(['calculator'])],
    },

    // -----------------------------------------------------------------------
    // S2：权限 fail-safe 的反向验证——非交互环境（无 confirm 通道）里，
    // medium 风险的 researcher 必须被抓为 permission_denied 结果注入对话，
    // 而**不是**崩溃或静默放行；模型读到拒绝后继续作答（ADR-005：
    // 拒绝是「对话的一部分」，Loop 收敛为 completed）。
    // -----------------------------------------------------------------------
    {
      name: 'permission-fail-safe',
      description: '权限 fail-safe：无确认通道 → 中风险工具被拒绝但对话继续',
      input: '帮我派研究员计算 1 + 1',
      script: [
        { text: '我派研究员。', toolCalls: [{ name: 'researcher', args: { task: '计算 1 + 1' } }] },
        { text: '既然没有权限，我直接口头回答：1 + 1 = 2。' },
      ],
      subagents: [RESEARCHER],
      // autoApprovePermissions 缺省 false = 无确认通道 → fail-safe 拒绝
      assertions: [
        assertToolErrorCode({ tool: 'researcher', code: 'permission_denied' }),
        assertStopReason('completed'),
      ],
    },

    // -----------------------------------------------------------------------
    // S3：子代理完整回程 + 成本归属（w13 × w14 的交点）。
    // 断言读法：
    //   - 主世界工具序列 = [researcher]（子世界的 calculator 不泄漏进主序列）；
    //   - 子代理成功运行过（subagent_finished 事件且 ok）；
    //   - 子代理花费可从账本按归因维度查询（bySubagent——派生 queryId 解析）。
    // -----------------------------------------------------------------------
    {
      name: 'subagent-roundtrip',
      description: '子代理回程：隔离执行 + 成本按归因维度可查',
      input: '派研究员弄清 21 * 2 的结果',
      script: [
        {
          text: '我派研究员。',
          toolCalls: [{ name: 'researcher', args: { task: '计算 21 * 2 并给出一句话结论' } }],
        },
        { text: '收到研究员结论。' },
      ],
      subagents: [RESEARCHER],
      subagentScripts: { researcher: RESEARCHER_SCRIPT },
      autoApprovePermissions: true,
      assertions: [
        assertStopReason('completed'),
        assertToolSequence(['researcher']),
        assertSubagentRan('researcher'),
        assertCostUnder(1, { subagent: 'researcher' }), // 归因维度：子代理
        assertCostUnder(1), // 总账维度
      ],
    },

    // -----------------------------------------------------------------------
    // S4：压缩链的触发器——单条工具输出超过 toolOutputMaxTokens 时，
    // Context 层在组装前把 tool 消息截断（L1），并发 context_compressed 事件。
    // 断言读法：事件真的出现过（机制发动），且整体流程仍 completed
    // （压缩是「降级而非失败」——这是压缩链最重要的一条契约）。
    // -----------------------------------------------------------------------
    {
      name: 'context-compression',
      description: '压缩链：超限工具输出触发 L1 截断且流程不受影响',
      input: '请把这段长文本原样回显',
      script: [
        {
          text: '回显中……',
          // 1200 字符（≈300 tok）远超 100 tok 阈值 → L1 必然触发
          toolCalls: [{ name: 'echo', args: { message: 'x'.repeat(1200) } }],
        },
        { text: '完成。' },
      ],
      overrides: { context: { toolOutputMaxTokens: 100 } },
      assertions: [assertEventEmitted('context_compressed'), assertStopReason('completed')],
    },
  ];
}
