/**
 * Tracer —— 全量事件的「环形缓冲 + 检索视图」。
 *
 * 一句话定位：EventBus 上发生的一切，Tracer 都看一眼、留一份、可回查——
 * 但绝不插手。它是「事后诊断」的底座（谁在什么时候发了什么事件、
 * 一次 query 完整体验长什么样）。
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 三个设计决策（grill 常问）                                            │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * ① 为什么订阅 '*' 而不是几个关键事件？
 *    观测者的价值在于「完整性」——Tracer 预判哪些事件重要，恰恰会漏掉
 *    未来新增的事件（w13 加 subagent_* 时，Tracer 一行没改就是这么来的）。
 *    过滤是「查询时」的事（byType / byQuery），不是「订阅时」的事。
 *
 * ② 为什么是环形缓冲（容量上限）而不是无限数组？
 *    长驻进程的事件量无上界（每次模型调用、每个流分片……）——无限增长
 *    就是内存泄漏。容量满后丢弃最老（receivedCount - count = 丢弃数，
 *    丢弃本身可观测）。⚠️ 已知取舍：教学实现用数组 shift()——O(n) 移动；
 *    高频生产应改为循环下标覆盖。当前规模（万级事件）无感知。
 *
 * ③ 为什么查询结果要按 seq 重新排序？
 *    同步总线上的「重入 emit」：CostTracker 在处理 llm_response 时同步
 *    emit usage_recorded（101），而 llm_response（100）本身还没分发完——
 *    缓冲内的插入顺序会出现局部 [101, 100]。这不是 bug 而是同步总线的
 *    真实语义；Tracer 在「读」时按 seq 恢复逻辑顺序，让查询方免疫。
 *    （将来若改异步分发，排序逻辑可以删——但事件顺序断言会变弱，
 *      这正是保留同步总线的理由之一，见 events.ts。）
 *
 * 依赖方向：observability/tracer.ts → kernel/events.ts / config.ts。零控制流影响。
 */

import type { ObservabilityConfig } from '../config.ts';
import type { EventBus, EventName, HarnessEvent } from '../kernel/events.ts';
import { HarnessError } from '../errors.ts';

// ===========================================================================
// §1 选项与查询形状
// ===========================================================================

export interface TracerOptions {
  readonly bus: EventBus;
  /** 可观测域配置（trace 开关 + 缺省容量） */
  readonly config: ObservabilityConfig;
  /** 容量覆盖（缺省取 config.traceCapacity；测试用小容量演示丢弃行为） */
  readonly capacity?: number;
}

/**
 * queryId 查询的补充语义。
 * includeDerived：把「派生 queryId」（`父q>agent`）也计入——
 * 对「这次提问总共花了什么」的统计必须包含子代理活动（w13 的派生链）。
 */
export interface TraceQuery {
  readonly includeDerived?: boolean;
}

// ===========================================================================
// §2 Tracer 实现
// ===========================================================================

export class Tracer {
  private readonly bus: EventBus;
  private readonly isEnabled: boolean;
  private readonly capacity: number;
  /** 环形缓冲（数组 + shift 的教学实现，性能取舍见文件头决策 ②） */
  private readonly buffer: HarnessEvent[] = [];
  private received = 0;
  private unsubscribe: (() => void) | undefined;

  constructor(options: TracerOptions) {
    this.bus = options.bus;
    this.isEnabled = options.config.trace;
    const capacity = options.capacity ?? options.config.traceCapacity;
    if (capacity <= 0) {
      throw new HarnessError('config_error', `Tracer 容量必须为正数，当前 ${capacity}`, {
        where: 'observability/tracer',
      });
    }
    this.capacity = capacity;

    // 关闭态 = 不订阅（零开销的开关语义：连回调都不存在）
    if (this.isEnabled) {
      this.unsubscribe = this.bus.on('*', (event) => {
        this.accept(event);
      });
    }
  }

  /** 是否在采集（config.observability.trace 的运行时视图） */
  get enabled(): boolean {
    return this.isEnabled;
  }

  /** 当前留存的事件数（≤ capacity） */
  get count(): number {
    return this.buffer.length;
  }

  /** 历史收到的事件总数（含已被环形缓冲丢弃的） */
  get receivedCount(): number {
    return this.received;
  }

  /** 已丢弃的事件数 = received - count（丢弃可观测——否则容量就是静默黑洞） */
  get droppedCount(): number {
    return this.received - this.buffer.length;
  }

  // -------------------------------------------------------------------------
  // 查询视图（全部按 seq 升序返回快照——外部拿到的数组不可影响内部缓冲）
  // -------------------------------------------------------------------------

  all(): readonly HarnessEvent[] {
    return this.sorted(this.buffer);
  }

  byType(type: EventName): readonly HarnessEvent[] {
    return this.sorted(this.buffer.filter((event) => event.type === type));
  }

  bySession(sessionId: string): readonly HarnessEvent[] {
    return this.sorted(this.buffer.filter((event) => event.sessionId === sessionId));
  }

  /**
   * 按 queryId 检索。
   * 缺省精确匹配；includeDerived=true 时额外包含 `queryId>...` 前缀的
   * 派生事件（子代理世界）——「这次提问 + 它的全部子工作」。
   */
  byQuery(queryId: string, query: TraceQuery = {}): readonly HarnessEvent[] {
    const derivedPrefix = query.includeDerived === true ? `${queryId}>` : undefined;
    return this.sorted(
      this.buffer.filter(
        (event) =>
          event.queryId === queryId ||
          (derivedPrefix !== undefined && event.queryId?.startsWith(derivedPrefix) === true),
      ),
    );
  }

  /** 清空缓冲与计数（长驻进程的「观测重置」；测试隔离通常用新实例而非本方法） */
  clear(): void {
    this.buffer.length = 0;
    this.received = 0;
  }

  /** 退订（装配层在进程关闭 / 测试收尾时调用；无订阅时为幂等 no-op） */
  dispose(): void {
    if (this.unsubscribe !== undefined) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  // -------------------------------------------------------------------------
  // 内部实现
  // -------------------------------------------------------------------------

  private accept(event: HarnessEvent): void {
    this.received += 1;
    this.buffer.push(event);
    if (this.buffer.length > this.capacity) {
      this.buffer.shift(); // 丢最老（文件头决策 ②）
    }
  }

  private sorted(events: readonly HarnessEvent[]): readonly HarnessEvent[] {
    // 拷贝 + 排序：既保证外部不可改内部，也修复重入 emit 的局部乱序（决策 ③）
    return [...events].sort((a, b) => a.seq - b.seq);
  }
}
