/**
 * MemoryManager —— 记忆域门面：把 store / retriever / trigger 三件套
 * 编织进 SessionManager 的 query 生命周期。
 *
 * 生命周期接缝（两个挂点，均由 SessionManager 调用）：
 *
 *   query 开始 ── retrieveFor(input) ──→ 检索 → ContextInjections（透传给 Loop）
 *   query 终结 ── considerWrite(...) ──→ 触发判定 → 写入 + 事件
 *
 * 三个横切决策：
 *
 *   ① 短路语义（config.memory.enabled = false）：
 *      retrieveFor 返回空注入、considerWrite 返回空数组——记忆模块「完全
 *      不介入」（不读库、不写库、不发事件）。总开关必须真的关得掉。
 *
 *   ② 失败隔离（「记忆是增强，不是核心路径」）：
 *      本模块所有对外方法自吞异常——失败上报 log warn 事件后返回安全空值。
 *      调用方（SessionManager）因此不需要 try-catch。理由：记忆库损坏不应该
 *      让用户无法对话；这与「工具错误收敛为结果」的哲学一致（错误降级而不是
 *      炸链路），但比工具更彻底——连降级内容都不给（空注入 = 无记忆模式）。
 *
 *   ③ 先事实后观测：写入/检索完成后才 emit 事件——事件描述事实，
 *      事实先于观测存在（与 SessionManager 的 commitPoint 同一纪律）。
 *
 * 依赖方向：memory/manager.ts → memory/store + retriever + trigger
 *           + config（类型）+ kernel/events + errors + context/manager（类型）。
 */

import type { ContextInjections } from '../context/manager.ts';
import type { MemoryConfig } from '../config.ts';
import { toHarnessError } from '../errors.ts';
import type { EventBus } from '../kernel/events.ts';
import { composeInjections, retrieveMemories } from './retriever.ts';
import type { MemoryRecord, MemoryStore } from './store.ts';
import { decideMemoryWrites } from './trigger.ts';

// ===========================================================================
// §1 选项与形状
// ===========================================================================

export interface MemoryManagerOptions {
  readonly store: MemoryStore;
  readonly config: MemoryConfig;
  readonly bus: EventBus;
}

/** 事件关联维度（与 SessionManager 的 query 维度对齐） */
export interface MemoryQueryContext {
  readonly sessionId: string;
  readonly queryId: string;
}

/** considerWrite 的输入：一次 query 的完整结局快照 */
export interface QueryOutcomeInput extends MemoryQueryContext {
  readonly input: string;
  /** 最终回答文本（触发器 v1 未消费——R2/结论规则启用时使用） */
  readonly finalText: string | undefined;
  readonly stopReason: string;
}

// ===========================================================================
// §2 MemoryManager
// ===========================================================================

export class MemoryManager {
  private readonly store: MemoryStore;
  private readonly config: MemoryConfig;
  private readonly bus: EventBus;

  constructor(options: MemoryManagerOptions) {
    this.store = options.store;
    this.config = options.config;
    this.bus = options.bus;
  }

  // -------------------------------------------------------------------------
  // 检索（query 开始）
  // -------------------------------------------------------------------------

  /**
   * 为一次 query 检索相关记忆，组装为 profile/task 注入。
   *
   * 检索时机说明：v1 每 query 检索一次（查询文本 = 用户输入）。为什么不每轮
   * 重新检索：轮次之间用户输入不变 → 检索结果不变 → 纯重复计算；真实场景中
   * 「上下文相关检索」由 query 级触发已覆盖大部分价值（演进点：按最近消息滑窗
   * 检索）。
   *
   * @returns 注入对象（无命中 / 关闭 / 失败 → 空对象——绝不抛错）
   */
  retrieveFor(query: string, ctx: MemoryQueryContext): ContextInjections {
    if (!this.config.enabled) return {};
    try {
      const records = this.store.list();
      const scored = retrieveMemories(records, query, {
        topK: this.config.retrievalTopK,
        minScore: this.config.minRelevanceScore,
      });
      const result = composeInjections(scored);
      if (result.count > 0) {
        this.bus.emit({
          type: 'memory_retrieved',
          count: result.count,
          topScore: result.topScore,
          sessionId: ctx.sessionId,
          queryId: ctx.queryId,
        });
      }
      return result.injections;
    } catch (raw) {
      this.warn('记忆检索失败，已降级为空注入', raw);
      return {};
    }
  }

  // -------------------------------------------------------------------------
  // 触发写入（query 终结）
  // -------------------------------------------------------------------------

  /**
   * 对一次已终结的 query 做记忆写入白名单判定，命中的写入库并返回。
   *
   * 调用时机约定（由 SessionManager 保证）：query 正常终结（completed /
   * aborted）之后调用；异常路径（failed）不调用——「一半的对话」里提取的
   * 「记忆」没有可信度。
   *
   * @returns 本次写入的记录（0~n 条；关闭 / 无命中 / 失败 → 空数组——绝不抛错）
   */
  considerWrite(args: QueryOutcomeInput): readonly MemoryRecord[] {
    if (!this.config.enabled) return [];
    try {
      const decisions = decideMemoryWrites({
        input: args.input,
        finalText: args.finalText,
        stopReason: args.stopReason,
      });
      const written: MemoryRecord[] = [];
      for (const decision of decisions) {
        const record = this.store.write({
          kind: decision.kind,
          content: decision.content,
          sourceSessionId: args.sessionId,
        });
        written.push(record);
        this.bus.emit({
          type: 'memory_written',
          recordId: record.id,
          kind: record.kind,
          sessionId: args.sessionId,
          queryId: args.queryId,
        });
      }
      return written;
    } catch (raw) {
      this.warn('记忆写入失败（已忽略——记忆是增强不是核心路径）', raw);
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // 内部实现
  // -------------------------------------------------------------------------

  /** 统一的降级告警（错误对象转换为 HarnessError 后取 message 与 where） */
  private warn(message: string, raw: unknown): void {
    const error = toHarnessError(raw, 'memory/manager');
    this.bus.emit({
      type: 'log',
      level: 'warn',
      message: `${message}：${error.message}`,
    });
  }
}
