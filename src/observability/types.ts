/**
 * Observability 层类型 —— 账本与追踪的「事实形状」。
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 本层定位：EventBus 的「只读消费者」——观测不参与控制流                 │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * 两个组件（tracer.ts / cost.ts），全部是「订阅 → 记录 → 提供查询」：
 *   1. Tracer：订阅 '*' 全量事件 → 环形缓冲留存 → 按 seq / 会话 / query 检索。
 *      （全量落盘（NDJSON）是明确的演进点；v1 只解决「内存内可查」。）
 *   2. CostTracker：订阅 llm_response（携带 model + usage）→ 查定价表
 *      → 落一条 CostEntry → 产出 usage_recorded 事件（已定价的用量事实）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 必答问题（grill 高频题；完整答卷见 tracer.ts / cost.ts 的文件头）：
 *
 * ① 为什么可观测层不允许拦截/修改事件？
 *    事件在 EventBus 层就被浅冻结（emit 时 Object.freeze），观测者拿到的是
 *    只读事实；控制流只走返回值（ToolResult / HookOutcome / Loop 判断）。
 *    一旦观测层能改写事件，「观测组件」就变成了「隐式业务逻辑 + 可用性单点」。
 *
 * ② 子代理（w13）的成本怎么归属？
 *    子世界的 llm_response 事件天然带派生 queryId（`父q>researcher`）。
 *    CostTracker 从 queryId 解析出 subagent 字段 → bySubagent() 聚合。
 *    不需要任何内核改动——这是 w13「派生 queryId」设计的事后收益：
 *    当时只为了诊断归因，成本归属「顺便」就成立了。
 *
 * ③ w04 草案「CostTracker 订阅 usage_recorded」为什么改成了现在这样？
 *    定价权必须在成本域：usage_recorded 的语义是「已定价」，而定价知识
 *    （价格表）只有成本域持有。若订阅方自己发明价格，账本会出现多份
 *    互相矛盾的定价。实现链是单向的：llm_response →（计价）→ usage_recorded。
 *    （config.ts 与 events.ts 的旧注释已同步修正。）
 *
 * 依赖方向：observability/types.ts → types.ts（全局 Usage）。纯形状，零逻辑。
 */

import type { Usage } from '../types.ts';

// ===========================================================================
// §1 定价与账本
// ===========================================================================

/** 单个模型的定价（每百万 token 的美元价格） */
export interface ModelPrice {
  readonly inputPerMTokUsd: number;
  readonly outputPerMTokUsd: number;
}

/**
 * 定价表：model 标识 → 价格。
 * 缺项语义 = 「未定价」：成本记 undefined（不猜测——宁缺毋滥，
 * 假价格比没价格更危险，会计口径失真且难以发现）。
 */
export type PricingTable = Readonly<Record<string, ModelPrice>>;

/** 一次已计价的模型调用（成本账本的最小条目） */
export interface CostEntry {
  /** 事件时间戳（继承自 llm_response 的 ts——注入时钟下完全确定性） */
  readonly at: number;
  readonly sessionId: string | undefined;
  readonly queryId: string | undefined;
  readonly model: string;
  readonly usage: Usage;
  /**
   * 从派生 queryId 解析出的子代理名（`父q>researcher` → 'researcher'）。
   * 主世界调用为 undefined；嵌套子代理取最后一段（`q>a>b` → 'b'）。
   */
  readonly subagent: string | undefined;
  /** 估算成本（美元）。undefined = 模型未定价（见 PricingTable 注释） */
  readonly estimatedCostUsd: number | undefined;
}

/**
 * 聚合摘要（total / byXxx 的统一返回形状）。
 * 为什么单独抽这个形状而不是返回条目数组？聚合口径只有一处实现
 * （cost.ts 的 summarize），所有查询维度共享同一套加法——口径不会分叉。
 */
export interface CostSummary {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** 已定价条目的成本合计；未定价条目贡献 0 并被 unpricedCalls 计数 */
  readonly estimatedCostUsd: number;
  /** 未定价调用数（>0 表示成本被低估，需要补定价表） */
  readonly unpricedCalls: number;
}
