/**
 * 子代理域场景 —— fan-out 编排与「分账可分辨」。
 *
 * 两个场景的分工：
 *   subagent-fanout-accounting ← 全成功路径：spawn 一次调用并发派两支，
 *     用「researcher=2 次 vs analyst=3 次」的数值差异证明账本按代理归因
 *     可分辨（比「都有账」强——数字对不上就是归因串了）；
 *   subagent-partial-failure  ← 局部失败路径：一支成功一支失败，各自如实
 *     结算（ok / ok:false），父流程不被打断——fan-out 的容错语义。
 *
 * 断言读法：subagent_finished 事件（每支的结局）+ cost.bySubagent（归属
 * 维度）+ 父世界的 spawn 结算——三条证据链分别对应「子世界」「账本」
 * 「父世界」，互不混淆。
 *
 * 依赖方向：scenarios/subagent.ts → src/eval（断言与类型）+ 模块公开类型。
 */

import type { EvalScenario } from '../src/eval/index.ts';
import {
  assertCostUnder,
  assertStopReason,
  assertSubagentRan,
  assertToolSequence,
} from '../src/eval/index.ts';
import type { HarnessEvent } from '../src/kernel/events.ts';
import type { FakeTurn } from '../src/llm/fake-provider.ts';
import type { SubAgentDefinition } from '../src/subagent/types.ts';

// ===========================================================================
// §1 共享装置
// ===========================================================================

/** 研究员：剧本 2 轮（算一次 + 结论）= 2 次 LLM 调用 */
const RESEARCHER: SubAgentDefinition = {
  name: 'researcher',
  description: '资料调研子代理（受控演示：calculator 可用）',
  systemPrompt: '你是资料研究员。完成指派任务后，用一句话给出结论。',
  toolNames: ['calculator'],
  maxTurns: 3,
};

const RESEARCHER_SCRIPT: readonly FakeTurn[] = [
  { text: '我来计算。', toolCalls: [{ name: 'calculator', args: { expression: '21 * 2' } }] },
  { text: '结论：21 * 2 = 42。' },
];

/** 分析师：剧本 3 轮（连续两次计算 + 结论）= 3 次 LLM 调用 */
const ANALYST: SubAgentDefinition = {
  name: 'analyst',
  description: '数据分析子代理（受控演示：分步计算）',
  systemPrompt: '你是数据分析师。按步骤完成计算，最后给出一句话结论。',
  toolNames: ['calculator'],
  maxTurns: 4,
};

const ANALYST_SCRIPT: readonly FakeTurn[] = [
  { text: '先算第一个。', toolCalls: [{ name: 'calculator', args: { expression: '1 + 1' } }] },
  { text: '再算第二个。', toolCalls: [{ name: 'calculator', args: { expression: '2 + 2' } }] },
  { text: '结论：两个结果分别是 2 与 4。' },
];

/** 不稳定代理：首次调用即模拟上游波动（provider_error）——局部失败的来源 */
const FLAKY: SubAgentDefinition = {
  name: 'flaky',
  description: '不稳定子代理（本场景专用：首次调用必失败）',
  systemPrompt: '你是实验性子代理。',
  toolNames: ['echo'],
  maxTurns: 2,
};

const FLAKY_SCRIPT: readonly FakeTurn[] = [
  { fail: { code: 'provider_error', message: '模拟上游服务波动（评测场景专用）' } },
];

// ===========================================================================
// §2 场景
// ===========================================================================

export function createSubagentScenarios(): readonly EvalScenario[] {
  return [
    // -----------------------------------------------------------------------
    // subagent-fanout-accounting：模型一次 spawn_subagents 调用并发派发
    // 两支（researcher 2 次 LLM 调用 / analyst 3 次）。
    // 断言读法：
    //   - 父世界工具序列 = [spawn_subagents]（子世界的 calculator 不泄漏）；
    //   - 两支都真跑过（subagent_finished ok）；
    //   - 分账精确到次数：bySubagent('researcher').calls=2 且 analyst=3
    //     ——数字必须对得上，归因串线立刻暴露。
    // -----------------------------------------------------------------------
    {
      name: 'subagent-fanout-accounting',
      description: '子代理 fan-out：spawn 并发派发，成本按代理分账可分辨（2 vs 3）',
      input: '请并发完成两个独立任务：researcher 算 21*2，analyst 依次算 1+1 与 2+2',
      script: [
        {
          text: '我把两个任务拆开并发派发。',
          toolCalls: [
            {
              name: 'spawn_subagents',
              args: {
                tasks: [
                  { agent: 'researcher', task: '计算 21 * 2 并给出一句话结论' },
                  { agent: 'analyst', task: '依次计算 1 + 1 与 2 + 2，最后给出一句话结论' },
                ],
              },
            },
          ],
        },
        { text: '两个子任务都已结算，我来汇总。' },
      ],
      subagents: [RESEARCHER, ANALYST],
      subagentScripts: { researcher: RESEARCHER_SCRIPT, analyst: ANALYST_SCRIPT },
      enableOrchestrator: true,
      autoApprovePermissions: true, // spawn_subagents 是 medium 风险（无确认通道会被 fail-safe 拒绝）
      assertions: [
        assertStopReason('completed'),
        assertToolSequence(['spawn_subagents']),
        assertSubagentRan('researcher'),
        assertSubagentRan('analyst'),
        {
          name: '分账可分辨：researcher=2 次、analyst=3 次 LLM 调用',
          check: (evidence) => {
            const cost = evidence.cost;
            if (cost === undefined) {
              return '未装配 CostTracker（场景需保持 config.observability.costTracking=true）';
            }
            const r = cost.bySubagent('researcher').calls;
            const a = cost.bySubagent('analyst').calls;
            if (r === 2 && a === 3) return undefined;
            return `期望 researcher=2、analyst=3，实际 researcher=${r}、analyst=${a}（账本按代理归因失真）`;
          },
        },
        assertCostUnder(1), // 总账闭环（与 S3 的归因断言同族）
      ],
    },

    // -----------------------------------------------------------------------
    // subagent-partial-failure：并发两支，researcher 成功、flaky 失败。
    // 断言读法（partial 语义的三条证据）：
    //   - 成功支 ok 结算（assertSubagentRan 缺省语义）；
    //   - 失败支 ok:false 结算（w18 扩展——失败必须如实落账）；
    //   - 父世界 spawn 工具本身 ok=true（局部失败不升级为父失败——
    //     父模型读到报告里的失败清单后自行决策，Loop 收敛 completed）。
    // -----------------------------------------------------------------------
    {
      name: 'subagent-partial-failure',
      description: '子代理局部失败：一支成功一支失败，各自如实结算且父流程不断',
      input: '请并发派两个任务：researcher 算 21*2，flaky 做一件会失败的事',
      script: [
        {
          text: '并发派发。',
          toolCalls: [
            {
              name: 'spawn_subagents',
              args: {
                tasks: [
                  { agent: 'researcher', task: '计算 21 * 2' },
                  { agent: 'flaky', task: '执行一个上游会波动的任务' },
                ],
              },
            },
          ],
        },
        { text: '部分成功：研究员给出了结论；另一个任务失败了，需要时可以重试。' },
      ],
      subagents: [RESEARCHER, FLAKY],
      subagentScripts: { researcher: RESEARCHER_SCRIPT, flaky: FLAKY_SCRIPT },
      enableOrchestrator: true,
      autoApprovePermissions: true,
      assertions: [
        assertStopReason('completed'),
        assertSubagentRan('researcher'), // 成功支
        assertSubagentRan('flaky', { ok: false }), // 失败支如实结算（w18 扩展）
        {
          name: 'spawn 工具本身成功结算（子失败不升级为父失败）',
          check: (evidence) => {
            const finished = evidence.events.find(
              (event): event is Extract<HarnessEvent, { type: 'tool_finished' }> =>
                event.type === 'tool_finished' && event.name === 'spawn_subagents',
            );
            if (finished === undefined) {
              return '未找到 spawn_subagents 的 tool_finished 事件';
            }
            if (finished.ok) return undefined;
            return `期望 spawn 结算为 ok（局部失败写进报告），实际失败（${finished.errorCode ?? 'unknown'}）`;
          },
        },
      ],
    },
  ];
}
