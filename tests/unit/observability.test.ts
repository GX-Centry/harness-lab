/**
 * observability 层单元测试：Tracer（全量追踪）与 CostTracker（计价账本）。
 *
 * 锚定的决策（对应两个源文件头部的「决策」清单）：
 *   - Tracer：订阅 '*' 的完整性、环形缓冲丢弃可观测、查询按 seq 抗重入乱序、
 *     关闭 = 零订阅；
 *   - CostTracker：定价是唯一转换点（llm_response → usage_recorded 单向）、
 *     未定价「宁缺毋滥」（不发布假价格）、subagent 归因（派生 queryId 解析）、
 *     四维聚合（session/query/subagent/model）与统一口径。
 */

import { describe, expect, it } from 'vitest';
import type { ObservabilityConfig } from '../../src/config.ts';
import { EventBus } from '../../src/kernel/events.ts';
import { CostTracker, DEMO_PRICING } from '../../src/observability/cost.ts';
import { Tracer } from '../../src/observability/tracer.ts';

// ===========================================================================
// §0 测试装置
// ===========================================================================

/** 观测域配置便捷构造（缺省全开——用例再按需覆盖单项） */
function obs(overrides: Partial<ObservabilityConfig> = {}): ObservabilityConfig {
  return { trace: true, traceCapacity: 1_000, costTracking: true, ...overrides };
}

/**
 * llm_response 的最小合法输入（emit 会补全 seq/ts——入参不含它们）。
 * 缺省 model 用 DEMO_PRICING 里已定价的 'fake/model-1'。
 */
function llmResponseInput(
  options: {
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    sessionId?: string;
    queryId?: string;
  } = {},
) {
  return {
    type: 'llm_response' as const,
    model: options.model ?? 'fake/model-1',
    stopReason: 'end_turn' as const,
    usage: { inputTokens: options.inputTokens ?? 0, outputTokens: options.outputTokens ?? 0 },
    toolCallCount: 0,
    latencyMs: 1,
    sessionId: options.sessionId,
    queryId: options.queryId,
  };
}

// ===========================================================================
// §1 Tracer
// ===========================================================================

describe('Tracer', () => {
  it('环形缓冲：超容量丢最老，丢弃数可观测（received - count）', () => {
    const bus = new EventBus({ now: () => 0 });
    const tracer = new Tracer({ bus, config: obs(), capacity: 3 });
    for (let i = 0; i < 5; i += 1) {
      bus.emit({ type: 'session_created', sessionId: `s${i}` });
    }
    expect(tracer.count).toBe(3);
    expect(tracer.receivedCount).toBe(5);
    expect(tracer.droppedCount).toBe(2);
    // 留下的是最新 3 条（seq 3/4/5——丢弃的是 1/2）
    expect(tracer.all().map((event) => event.seq)).toEqual([3, 4, 5]);
  });

  it('查询视图：byType / bySession / byQuery 各自过滤（快照不影响内部缓冲）', () => {
    const bus = new EventBus({ now: () => 0 });
    const tracer = new Tracer({ bus, config: obs() });
    bus.emit({ type: 'session_created', sessionId: 's1' });
    bus.emit({ type: 'session_created', sessionId: 's2' });
    bus.emit(llmResponseInput({ sessionId: 's1', queryId: 'q1' }));

    expect(tracer.byType('session_created')).toHaveLength(2);
    expect(tracer.byType('llm_response')).toHaveLength(1);
    expect(tracer.bySession('s1').map((event) => event.type)).toEqual([
      'session_created',
      'llm_response',
    ]);
    expect(tracer.byQuery('q1')).toHaveLength(1);
    // 快照语义：all() 返回拷贝——改它不触碰内部缓冲
    const snapshot = [...tracer.all()];
    snapshot.pop();
    expect(tracer.count).toBe(3);
  });

  it('byQuery includeDerived：包含派生 queryId（子代理世界），且不误伤前缀相似者', () => {
    const bus = new EventBus({ now: () => 0 });
    const tracer = new Tracer({ bus, config: obs() });
    bus.emit({ type: 'query_start', inputLength: 1, queryId: 'q1' });
    bus.emit(llmResponseInput({ queryId: 'q1' }));
    bus.emit(llmResponseInput({ queryId: 'q1>researcher' }));
    bus.emit(llmResponseInput({ queryId: 'q10' })); // 前缀陷阱：'q10' 不属于 'q1' 的派生

    expect(tracer.byQuery('q1')).toHaveLength(2);
    expect(tracer.byQuery('q1', { includeDerived: true })).toHaveLength(3);
    expect(tracer.byQuery('q1', { includeDerived: true }).some((e) => e.queryId === 'q10')).toBe(
      false,
    );
  });

  it('抗重入乱序：CostTracker 同步重入 emit，查询时按 seq 恢复逻辑顺序', () => {
    // 场景还原（真实装配）：CostTracker 在 llm_response 的同步回调里 emit
    // usage_recorded——它「插队」分发完先落进 Tracer 缓冲，随后 llm_response
    // 本体才落入。物理插入顺序是 [usage_recorded(2), llm_response(1)]。
    const bus = new EventBus({ now: () => 0 });
    const tracer = new Tracer({ bus, config: obs() });
    const cost = new CostTracker({ bus, config: obs() });

    bus.emit(llmResponseInput({ inputTokens: 1_000_000, outputTokens: 1_000_000 }));

    // 查询视图：按 seq 排序 = 逻辑顺序（决策 ③ 的验收）
    expect(tracer.all().map((event) => event.type)).toEqual(['llm_response', 'usage_recorded']);
    // 账本与追踪互为印证
    expect(cost.total().estimatedCostUsd).toBe(4);
  });

  it('开关关闭 = 零订阅：enabled=false，一个事件都不收', () => {
    const bus = new EventBus({ now: () => 0 });
    const tracer = new Tracer({ bus, config: obs({ trace: false }) });
    bus.emit({ type: 'session_created' });
    expect(tracer.enabled).toBe(false);
    expect(tracer.receivedCount).toBe(0);
    expect(tracer.all()).toHaveLength(0);
  });

  it('dispose 退订后不再接收；重复 dispose 幂等', () => {
    const bus = new EventBus({ now: () => 0 });
    const tracer = new Tracer({ bus, config: obs() });
    bus.emit({ type: 'session_created' });
    tracer.dispose();
    tracer.dispose(); // 幂等
    bus.emit({ type: 'session_created' });
    expect(tracer.receivedCount).toBe(1);
  });

  it('容量非法（<= 0）抛 config_error——静默黑洞不可接受', () => {
    const bus = new EventBus();
    expect(() => new Tracer({ bus, config: obs(), capacity: 0 })).toThrow(/容量必须为正数/);
    expect(() => new Tracer({ bus, config: obs(), capacity: -1 })).toThrow(/容量必须为正数/);
  });
});

// ===========================================================================
// §2 CostTracker
// ===========================================================================

describe('CostTracker', () => {
  it('定价换算：查表 → 按 MTok 计费（0 与整数用例均精确）', () => {
    const bus = new EventBus({ now: () => 0 });
    const cost = new CostTracker({ bus, config: obs() });
    // DEMO_PRICING: fake/model-1 = $1/MTok 输入 + $3/MTok 输出
    bus.emit(llmResponseInput({ inputTokens: 1_000_000, outputTokens: 1_000_000 }));
    expect(cost.count).toBe(1);
    expect(cost.all()[0]?.estimatedCostUsd).toBe(4); // 1 + 3
    expect(cost.total()).toEqual({
      calls: 1,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      estimatedCostUsd: 4,
      unpricedCalls: 0,
    });
    // 0 用量也是「已定价」：cost = 0 而非 undefined（0 是有效价格，不是未知）
    bus.emit(llmResponseInput({}));
    expect(cost.all()[1]?.estimatedCostUsd).toBe(0);
  });

  it('usage_recorded 单向产出：已定价的用量事实才发布', () => {
    const bus = new EventBus({ now: () => 0 });
    const cost = new CostTracker({ bus, config: obs() });
    const recorded: number[] = [];
    bus.on('usage_recorded', (event) => {
      if (event.type !== 'usage_recorded') return; // 宽联合签名 → 运行时守卫收窄
      recorded.push(event.estimatedCostUsd);
    });
    bus.emit(llmResponseInput({ inputTokens: 500_000, outputTokens: 0 }));
    expect(recorded).toEqual([0.5]); // 0.5 MTok × $1
    expect(cost.count).toBe(1);
  });

  it('未定价模型：宁缺毋滥——条目照记、不发布假价格、unpricedCalls 计数', () => {
    const bus = new EventBus({ now: () => 0 });
    const cost = new CostTracker({ bus, config: obs({ costTracking: true }) });
    let recordedCount = 0;
    bus.on('usage_recorded', () => {
      recordedCount += 1;
    });
    bus.emit(llmResponseInput({ model: 'unknown/model', inputTokens: 1_000_000 }));
    expect(cost.count).toBe(1); // usage 是事实，照记
    expect(cost.all()[0]?.estimatedCostUsd).toBeUndefined(); // 但不猜价格
    expect(recordedCount).toBe(0); // usage_recorded 的 estimatedCostUsd 契约是必填 number
    expect(cost.total()).toEqual({
      calls: 1,
      inputTokens: 1_000_000,
      outputTokens: 0,
      estimatedCostUsd: 0, // 已定价部分为空 → 0
      unpricedCalls: 1, // 运维信号：该去补定价表了
    });
  });

  it('subagent 归因：从派生 queryId 解析末段（w13 的 `父q>agent` 约定事后变现）', () => {
    const bus = new EventBus({ now: () => 0 });
    const cost = new CostTracker({ bus, config: obs() });
    bus.emit(llmResponseInput({ queryId: 'q1', inputTokens: 1_000_000 })); // 主世界 $1
    bus.emit(llmResponseInput({ queryId: 'q1>researcher', outputTokens: 1_000_000 })); // 子代理 $3
    bus.emit(llmResponseInput({ queryId: 'q1>orchestrator>researcher', outputTokens: 0 })); // 嵌套取末段

    expect(cost.bySubagent('researcher').calls).toBe(2); // 两层嵌套都归到 researcher
    expect(cost.bySubagent('researcher').estimatedCostUsd).toBe(3);
    expect(cost.bySubagent('orchestrator').calls).toBe(0); // 中间层不是「离钱最近」的那层
    // 主世界调用无 subagent 归因（queryId 无 '>'）
    expect(cost.all().filter((entry) => entry.subagent === undefined)).toHaveLength(1);
  });

  it('byQuery includeDerived：「这次提问的总成本」含子代理花费', () => {
    const bus = new EventBus({ now: () => 0 });
    const cost = new CostTracker({ bus, config: obs() });
    bus.emit(llmResponseInput({ queryId: 'q1', inputTokens: 1_000_000 })); // $1
    bus.emit(llmResponseInput({ queryId: 'q1>researcher', outputTokens: 1_000_000 })); // $3

    expect(cost.byQuery('q1').calls).toBe(1);
    expect(cost.byQuery('q1').estimatedCostUsd).toBe(1);
    expect(cost.byQuery('q1', { includeDerived: true }).calls).toBe(2);
    expect(cost.byQuery('q1', { includeDerived: true }).estimatedCostUsd).toBe(4);
  });

  it('bySession / byModel：另外两维聚合各自成立', () => {
    const bus = new EventBus({ now: () => 0 });
    const cost = new CostTracker({ bus, config: obs() });
    bus.emit(llmResponseInput({ sessionId: 's1', inputTokens: 1_000_000 }));
    bus.emit(llmResponseInput({ sessionId: 's2', model: 'unknown/model' }));

    expect(cost.bySession('s1').calls).toBe(1);
    expect(cost.bySession('s1').estimatedCostUsd).toBe(1);
    expect(cost.bySession('s2').unpricedCalls).toBe(1);
    expect(cost.byModel('fake/model-1').calls).toBe(1);
    expect(cost.byModel('unknown/model').calls).toBe(1);
  });

  it('定价表可注入（缺省 DEMO_PRICING）——价格是数据不是行为配置', () => {
    const bus = new EventBus({ now: () => 0 });
    const cost = new CostTracker({
      bus,
      config: obs(),
      pricing: { 'x/y': { inputPerMTokUsd: 2, outputPerMTokUsd: 4 } },
    });
    bus.emit(llmResponseInput({ model: 'x/y', inputTokens: 2_000_000, outputTokens: 1_000_000 }));
    expect(cost.total().estimatedCostUsd).toBe(8); // 4 + 4
    // 演示定价表导出且含演示条目（真价格由接入方提供，见 cost.ts 决策 ③）
    expect(DEMO_PRICING['fake/model-1']).toBeDefined();
  });

  it('开关关闭 = 不订阅：enabled=false，账本为空', () => {
    const bus = new EventBus({ now: () => 0 });
    const cost = new CostTracker({ bus, config: obs({ costTracking: false }) });
    bus.emit(llmResponseInput({ inputTokens: 1_000_000 }));
    expect(cost.enabled).toBe(false);
    expect(cost.count).toBe(0);
  });

  it('dispose 退订后不再记账；重复 dispose 幂等', () => {
    const bus = new EventBus({ now: () => 0 });
    const cost = new CostTracker({ bus, config: obs() });
    bus.emit(llmResponseInput({ inputTokens: 1_000_000 }));
    cost.dispose();
    cost.dispose(); // 幂等
    bus.emit(llmResponseInput({ inputTokens: 1_000_000 }));
    expect(cost.count).toBe(1);
  });
});
