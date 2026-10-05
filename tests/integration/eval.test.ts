/**
 * Eval 闭环集成测试。
 *
 * 锚定的行为：
 *   - 内置四场景端到端全过（w07/w08/w09/w13 能力的组合冒烟——三层测试
 *     策略里 scenarios 层的最小形态）；
 *   - 失败收集：一个场景的**全部**断言都执行（非 fail-fast）、断言自身
 *     抛错不炸批次、run 抛错被收敛为场景失败（eval 不做新的崩溃源）；
 *   - 开关联动：costTracking=false 时 assertCostUnder 给出自足失败原因；
 *   - 报告渲染与计数（CI 退出码的数据来源）。
 */

import { describe, expect, it } from 'vitest';
import {
  assertCostUnder,
  assertStopReason,
  assertToolSequence,
  createBuiltinScenarios,
  renderEvalReport,
  runScenario,
  runScenarios,
} from '../../src/eval/index.ts';
import type { EvalScenario } from '../../src/eval/index.ts';

// ===========================================================================
// §1 内置基准场景（正例）
// ===========================================================================

describe('内置基准场景', () => {
  it('四个场景全部通过（4/4）', async () => {
    const report = await runScenarios(createBuiltinScenarios());
    expect(report.total).toBe(4);
    expect(report.passed).toBe(4);
    expect(report.failed).toBe(0);
    // 全部通过时不应有任何失败清单
    expect(report.results.every((result) => result.failures.length === 0)).toBe(true);
  });

  it('S3 摘要：主世界工具序列只含 researcher（子世界活动不泄漏）', async () => {
    const scenario = createBuiltinScenarios().find((s) => s.name === 'subagent-roundtrip');
    if (scenario === undefined) throw new Error('内置场景 subagent-roundtrip 缺失');
    const result = await runScenario(scenario);
    expect(result.ok).toBe(true);
    expect(result.summary.stopReason).toBe('completed');
    expect(result.summary.toolCalls).toEqual(['researcher']);
  });

  it('报告渲染：标题含通过计数，通过行含场景名与摘要', async () => {
    const report = await runScenarios(createBuiltinScenarios());
    const text = renderEvalReport(report);
    expect(text).toContain('评测报告：4/4 通过');
    expect(text).toContain('basic-tool-loop');
    expect(text).toContain('subagent-roundtrip');
  });
});

// ===========================================================================
// §2 失败收集（反例——评测的「不 fail-fast」契约）
// ===========================================================================

describe('失败收集（非 fail-fast）', () => {
  it('一个场景的全部断言都执行，失败清单一次给全', async () => {
    const scenario: EvalScenario = {
      name: 'failing-by-design',
      description: '故意失败：两条断言都不满足',
      input: '随便说点什么',
      script: [{ text: '我直接作答，不调工具。' }],
      assertions: [
        assertStopReason('max_turns'), // 实际 completed → 失败
        assertToolSequence(['calculator']), // 实际无工具 → 失败
      ],
    };
    const result = await runScenario(scenario);
    expect(result.ok).toBe(false);
    // 关键证据：不是「遇到第一条失败就停」——两条都执行了
    expect(result.failures).toHaveLength(2);
    const text = result.failures.join('\n');
    expect(text).toContain('终止原因');
    expect(text).toContain('max_turns');
    expect(text).toContain('calculator');
  });

  it('断言自身抛错 = 评测 bug：记为失败并继续执行后续断言', async () => {
    const scenario: EvalScenario = {
      name: 'assertion-throws',
      description: '第一条断言抛错，第二条照常执行',
      input: '随便说点什么',
      script: [{ text: '好。' }],
      assertions: [
        {
          name: '会抛错的断言',
          check: () => {
            throw new Error('评测代码 bug');
          },
        },
        assertStopReason('completed'), // 它应该照常通过（不因前一条崩溃而中断）
      ],
    };
    const result = await runScenario(scenario);
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1); // 只有抛错那条
    expect(result.failures[0]).toContain('评测代码 bug');
  });

  it('run 抛错（剧本耗尽）被收敛为场景失败——eval 不做新的崩溃源', async () => {
    const scenario: EvalScenario = {
      name: 'script-exhausted',
      description: '剧本只写一轮但模型要调工具 → provider_error 穿出 → 收敛为失败',
      input: '请计算',
      script: [
        // 模型要调工具，却没有下一轮剧本——FakeProvider 抛 provider_error，
        // Loop 对致命错误向上抛（不做流式重放），runner 在边界收敛。
        { text: '我来计算。', toolCalls: [{ name: 'calculator', args: { expression: '1 + 1' } }] },
      ],
      assertions: [assertStopReason('completed')],
    };
    const result = await runScenario(scenario);
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toContain('场景执行抛错');
  });

  it('costTracking 关闭：assertCostUnder 给出自足失败原因（未装配）', async () => {
    const scenario: EvalScenario = {
      name: 'cost-disabled',
      description: '关闭成本账本后的断言失败形态',
      input: '随便说点什么',
      script: [{ text: '好。' }],
      overrides: { observability: { costTracking: false } },
      assertions: [assertCostUnder(1)],
    };
    const result = await runScenario(scenario);
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toContain('未装配 CostTracker');
  });

  it('runScenarios 的计数与失败清单一致（报告数据源）', async () => {
    const scenarios = createBuiltinScenarios();
    const bad: EvalScenario = {
      name: 'broken',
      description: '一条必败断言',
      input: '好',
      script: [{ text: '好。' }],
      assertions: [assertStopReason('aborted')], // 实际 completed
    };
    const report = await runScenarios([...scenarios, bad]);
    expect(report.total).toBe(5);
    expect(report.passed).toBe(4);
    expect(report.failed).toBe(1);
    // 失败场景在结果里保留完整失败清单（报告可定位到具体断言）
    const failedResult = report.results.find((result) => result.name === 'broken');
    expect(failedResult?.failures.join('\n')).toContain('aborted');
  });
});
