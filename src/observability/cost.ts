/**
 * CostTracker —— 用量 → 计价的唯一转换点。
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 数据流（一步都不能少，grill 常问）                                    │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 *   llm_response（model + usage + queryId；父/子世界都发到同一总线）
 *     → 查定价表 pricing[model]
 *     → 落 CostEntry（含从 queryId 派生的 subagent 归因字段）
 *     → 产出 usage_recorded 事件（「已定价的用量事实」）
 *
 * 订阅链单向、无环：llm_response → usage_recorded。
 * ⚠️ 同步总线下的重入：本类在处理 llm_response 的同步回调里 emit——
 * 该次 emit 会「插队」分发完，再回到原分发。事件的 seq 因此可能局部
 * 乱序抵达后续观察者（如 Tracer）——Tracer 按 seq 排序自愈（见 tracer.ts
 * 决策 ③；单元测试锚定了这个行为）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三个语义决策：
 *
 * ① 未定价模型（定价表缺项）怎么办？原则：**宁缺毋滥**。
 *    不猜测价格：条目照记（usage 是事实），estimatedCostUsd 记 undefined，
 *    摘要里进 unpricedCalls 计数；usage_recorded 不产出（它的契约里
 *    estimatedCostUsd 是必填 number——没定价就不发布假价格）。
 *    信号价值：unpricedCalls > 0 就是「去补定价表」的运维提示。
 *
 * ② 成本归属的维度怎么实现？
 *    session / query / subagent / model 四维（文档承诺）：
 *    - session / query：base 事件自带；
 *    - subagent：从派生 queryId 解析末段（`父q>researcher` → 'researcher'）——
 *      w13 的派生设计在此「事后变现」，内核零改动；
 *    - model：llm_response.model 字段。
 *    说明：原文档的「tool 维度」由 subagent 维度承接——普通工具不产生
 *    LLM 调用；唯一「工具里套模型调用」的形态就是 Agent-as-Tool，
 *    其花费 = 该子代理的账。不另设 tool 查询接口（避免假维度）。
 *
 * ③ 演示定价是「示例数据」不是真实价格：
 *    DEMO_PRICING 里 fake/model-1 的价格纯为演示账本数值可见；
 *    真实定价表由接入方提供（演进点：从官方定价页/接口同步）。
 *
 * 依赖方向：observability/cost.ts → kernel/events.ts / config.ts / types.ts。
 */

import type { ObservabilityConfig } from '../config.ts';
import type { EventBus, HarnessEvent } from '../kernel/events.ts';
import type { CostEntry, CostSummary, PricingTable } from './types.ts';
import type { TraceQuery } from './tracer.ts';

// ===========================================================================
// §1 演示定价与选项
// ===========================================================================

/**
 * 演示定价表（并非真实价格——见文件头决策 ③）。
 * 为什么定价表在「构造参数」而不是 config：价格是随市场变化的数据，
 * 不是行为配置；不同接入方/不同环境（测试桩）注入不同的表。
 */
export const DEMO_PRICING: PricingTable = {
  'fake/model-1': { inputPerMTokUsd: 1, outputPerMTokUsd: 3 },
};

export interface CostTrackerOptions {
  readonly bus: EventBus;
  /** 可观测域配置（costTracking 开关） */
  readonly config: ObservabilityConfig;
  /** 定价表（缺省 DEMO_PRICING） */
  readonly pricing?: PricingTable;
}

// ===========================================================================
// §2 CostTracker 实现
// ===========================================================================

export class CostTracker {
  private readonly bus: EventBus;
  private readonly pricing: PricingTable;
  private readonly isEnabled: boolean;
  private readonly ledger: CostEntry[] = [];
  private unsubscribe: (() => void) | undefined;

  constructor(options: CostTrackerOptions) {
    this.bus = options.bus;
    this.pricing = options.pricing ?? DEMO_PRICING;
    this.isEnabled = options.config.costTracking;

    if (this.isEnabled) {
      this.unsubscribe = this.bus.on('llm_response', (event) => {
        // EventBus.on 的处理器签名是宽联合（不按键收窄）——运行时守卫让
        // TS 收窄类型；同时这也是防御性编程（键错误时静默忽略而非崩）。
        // 演进点：EventBus.on 可以做「按键收窄的映射类型」签名（见 events.ts）。
        if (event.type !== 'llm_response') return;
        this.accept(event);
      });
    }
  }

  /** 是否在记账（config.observability.costTracking 的运行时视图） */
  get enabled(): boolean {
    return this.isEnabled;
  }

  /** 已记账条目数 */
  get count(): number {
    return this.ledger.length;
  }

  // -------------------------------------------------------------------------
  // 查询视图（原始条目 + 四个聚合维度）
  // -------------------------------------------------------------------------

  all(): readonly CostEntry[] {
    return [...this.ledger];
  }

  /** 总账（全部条目） */
  total(): CostSummary {
    return summarize(this.ledger);
  }

  bySession(sessionId: string): CostSummary {
    return summarize(this.ledger.filter((entry) => entry.sessionId === sessionId));
  }

  /**
   * 按 queryId 聚合。includeDerived=true 时把子代理（派生 queryId）的
   * 花费也计入——「这次提问的总成本」的正确答案需要它。
   */
  byQuery(queryId: string, query: TraceQuery = {}): CostSummary {
    const derivedPrefix = query.includeDerived === true ? `${queryId}>` : undefined;
    return summarize(
      this.ledger.filter(
        (entry) =>
          entry.queryId === queryId ||
          (derivedPrefix !== undefined && entry.queryId?.startsWith(derivedPrefix) === true),
      ),
    );
  }

  /** 按子代理聚合（归属维度见文件头决策 ②） */
  bySubagent(agent: string): CostSummary {
    return summarize(this.ledger.filter((entry) => entry.subagent === agent));
  }

  byModel(model: string): CostSummary {
    return summarize(this.ledger.filter((entry) => entry.model === model));
  }

  /** 退订（幂等 no-op 安全） */
  dispose(): void {
    if (this.unsubscribe !== undefined) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  // -------------------------------------------------------------------------
  // 内部实现
  // -------------------------------------------------------------------------

  private accept(event: HarnessEvent & { type: 'llm_response' }): void {
    const price = this.pricing[event.model];
    const costUsd =
      price === undefined
        ? undefined
        : (event.usage.inputTokens / 1_000_000) * price.inputPerMTokUsd +
          (event.usage.outputTokens / 1_000_000) * price.outputPerMTokUsd;

    this.ledger.push({
      at: event.ts,
      sessionId: event.sessionId,
      queryId: event.queryId,
      model: event.model,
      usage: event.usage,
      subagent: deriveSubagent(event.queryId),
      estimatedCostUsd: costUsd,
    });

    // 只发布「已定价」的用量事实（决策 ①）；失败重试等原始重试细节
    // 属于 llm_retry 事件，不在这里重复计价（重试后成功的 llm_response
    // 才是真实消耗——重试语义的账本口径）。
    if (costUsd !== undefined) {
      this.bus.emit({
        type: 'usage_recorded',
        model: event.model,
        usage: event.usage,
        estimatedCostUsd: costUsd,
        sessionId: event.sessionId,
        queryId: event.queryId,
      });
    }
  }
}

// ===========================================================================
// §3 工具函数
// ===========================================================================

/**
 * 从派生 queryId 解析子代理名（w13 的 `父q>agent` 约定）。
 * 嵌套（`q>a>b`）取最后一段——「离花的钱最近的那层代理」。
 * 无 '>' 或无 queryId → undefined（主世界调用）。
 */
function deriveSubagent(queryId: string | undefined): string | undefined {
  if (queryId === undefined) return undefined;
  const index = queryId.lastIndexOf('>');
  return index === -1 ? undefined : queryId.slice(index + 1);
}

/** 统一聚合口径（CostSummary 只有这一处加法——口径不会分叉） */
function summarize(entries: readonly CostEntry[]): CostSummary {
  let inputTokens = 0;
  let outputTokens = 0;
  let estimatedCostUsd = 0;
  let unpricedCalls = 0;
  for (const entry of entries) {
    inputTokens += entry.usage.inputTokens;
    outputTokens += entry.usage.outputTokens;
    if (entry.estimatedCostUsd === undefined) {
      unpricedCalls += 1;
    } else {
      estimatedCostUsd += entry.estimatedCostUsd;
    }
  }
  return { calls: entries.length, inputTokens, outputTokens, estimatedCostUsd, unpricedCalls };
}
