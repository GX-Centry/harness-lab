/**
 * SessionManager —— 会话状态机与「query 编排」（对齐 01-architecture §3 数据流）。
 *
 * 它在数据流中的位置：REPL 的每一行输入都经由本模块进入内核——
 *
 *   用户输入
 *     │
 *     ├─ createSession / getSession      会话取用（created → processing）
 *     ├─ runQuery(sessionId, input)      ← 本文件的核心编排
 *     │    ├─ 记忆检索（w11）：memory.retrieveFor(input) → 注入透传给 Loop
 *     │    ├─ 读持久化历史（loadMessages）
 *     │    ├─ 驱动 AgentLoop.run(input, history, runOptions)
 *     │    │    └─ onTurnEnd 快照 → commitPoint（消息差量 + 检查点，原子落盘）
 *     │    ├─ 终结提交（最终差量 + 终态，一次原子写）
 *     │    ├─ 记忆触发（w11）：memory.considerWrite(结局快照) → 白名单写入
 *     │    └─ 事件转发（LoopEvent 原样透传给 CLI 渲染层）
 *     └─ resumeSession                   中断恢复（interrupted/崩溃残留 → 补位）
 *
 * 三条写入纪律（配合 store.ts 的一致性模型，是崩溃恢复正确性的全部依据）：
 *
 *   ① 「数据先行、状态殿后」：任何时刻状态写入晚于数据提交。若崩溃落在
 *      「数据已写、状态未改」的窗口——恢复流程按「状态未更新」处理，
 *      结果安全（补位幂等、最多重复检查一次）。
 *   ② 「终结原子」：query 的最终消息差量与终态在一次 commit 中完成——
 *      避免「消息全落盘但状态停在 processing」的假中断。
 *   ③ 「一致点落盘」：只有 Loop 的轮次边界快照（配对完整）才进入存储——
 *      永远不存在「半个工具调用协议」被持久化。
 *
 * 统计口径提醒（为 w14 成本层铺垫）：
 *   一次 runQuery = 一次用户提问 = N 轮模型调用（turns）；用量累计在
 *   LoopResult.usage 里，按「查询」维度上报——本模块不做成本换算。
 *
 * 依赖方向：session/session-manager.ts → session/store + session/checkpoint
 *           + kernel/agent-loop（类型与运行）+ kernel/events + memory（门面）+ types/config/errors
 */

import { randomUUID } from 'node:crypto';
import type { HarnessConfig } from '../config.ts';
import { HarnessError, toHarnessError } from '../errors.ts';
import type { LoopContext, LoopEvent, LoopResult, LoopRunOptions } from '../kernel/agent-loop.ts';
import type { AgentLoop } from '../kernel/agent-loop.ts';
import type { EventBus } from '../kernel/events.ts';
import type { MemoryManager } from '../memory/manager.ts';
import type { Message, SessionState } from '../types.ts';
import { fillInterruptedToolResults } from './checkpoint.ts';
import type { SessionStore } from './store.ts';

// ===========================================================================
// §1 对外形状
// ===========================================================================

/** 会话元信息（CLI 的 /status、/sessions 命令消费） */
export interface SessionInfo {
  readonly id: string;
  readonly state: SessionState;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** 已持久化的消息条数 */
  readonly messageCount: number;
}

/** 恢复流程的结果报告（CLI 展示「恢复了什么」） */
export interface ResumeInfo {
  readonly sessionId: string;
  /** 恢复所依据的检查点 id */
  readonly checkpointId: string;
  /** 检查点记录到的轮次 */
  readonly turn: number;
  /** 恢复后可用的消息总数（= 检查点快照 + 本次补位） */
  readonly messageCount: number;
  /** 本次因「进程中断」被补占位的工具调用 id（空 = 上次的无调用缺失） */
  readonly filledToolCallIds: readonly string[];
}

export interface SessionManagerOptions {
  readonly store: SessionStore;
  /** 被编排的循环（构造级依赖——同一条 Loop 服务所有会话） */
  readonly loop: AgentLoop;
  readonly bus: EventBus;
  readonly config: HarnessConfig;
  /** 工具文件操作的沙箱根目录（转交 LoopContext） */
  readonly workingDir: string;
  /**
   * 记忆门面（w11，可选依赖）：提供 query 开始时的检索注入与终结时的
   * 触发写入。缺省 = 无记忆装配（单元测试、最小内核）——挂点自动降级
   * 为空操作（retrieveFor/considerWrite 的调用用可选链短路）。
   */
  readonly memory?: MemoryManager | undefined;
}

// ===========================================================================
// §2 SessionManager
// ===========================================================================

export class SessionManager {
  private readonly store: SessionStore;
  private readonly loop: AgentLoop;
  private readonly bus: EventBus;
  private readonly config: HarnessConfig;
  private readonly workingDir: string;
  private readonly memory: MemoryManager | undefined;

  /**
   * 「正在运行」的会话集合（进程内并发保护）。
   * 单进程假设：跨进程的并发（两个 CLI 同开一个会话）需要锁表——演进点，
   * 见 resumeSession 的僵尸态判定注释。
   */
  private readonly running = new Set<string>();

  constructor(options: SessionManagerOptions) {
    this.store = options.store;
    this.loop = options.loop;
    this.bus = options.bus;
    this.config = options.config;
    this.workingDir = options.workingDir;
    this.memory = options.memory;

    // after_tool 粒度需要 Loop 提供「每个工具执行后」的回调点（w10 未实现此
    // 接缝）——**不静默忽略**：显式降级为 every_turn（更粗但安全的粒度）并警告。
    // 演进路径：LoopRunOptions 增加 onToolExecuted 回调即可启用。
    if (this.config.session.checkpoint.mode === 'after_tool') {
      this.bus.emit({
        type: 'log',
        level: 'warn',
        message:
          'checkpoint.mode=after_tool 需要 Loop 的 per-tool 回调点（未实现），已降级为 every_turn',
      });
    }
  }

  // -------------------------------------------------------------------------
  // 会话生命周期
  // -------------------------------------------------------------------------

  /** 新建会话（id 缺省自动生成）；事件：session_created */
  createSession(id?: string): SessionInfo {
    const sessionId = id ?? `s_${randomUUID()}`;
    this.store.createSession(sessionId);
    this.bus.emit({ type: 'session_created', sessionId });
    return this.requireInfo(sessionId);
  }

  getSession(id: string): SessionInfo | undefined {
    return this.store.getSession(id);
  }

  /** 全部会话（最近活动倒序） */
  listSessions(): SessionInfo[] {
    return this.store.listSessions();
  }

  // -------------------------------------------------------------------------
  // 恢复流程（checkpoint 路径——只对 interrupted / 崩溃残留 processing 有意义）
  // -------------------------------------------------------------------------

  /**
   * 从中断中恢复会话：读最近检查点 → 为未完成的工具调用补占位（幂等）→
   * 崩溃残留的 processing 标记为 interrupted。之后调用方即可正常 runQuery 继续。
   *
   * 为什么「恢复」不自动接着跑：恢复的产出是「一个可继续的会话状态」，
   * 由谁决定继续（CLI 询问用户 / 自动续跑）是上层策略——本模块只做准备。
   */
  resumeSession(sessionId: string): ResumeInfo {
    const info = this.requireInfo(sessionId);

    if (this.running.has(sessionId)) {
      throw new HarnessError('internal_error', `会话正在运行中，不能执行恢复：${sessionId}`, {
        where: 'session/manager',
      });
    }
    // 僵尸态判定：单进程假设下，DB 里 processing 且内存 running 中无此会话
    // → 必为「上次进程崩溃的残留」——这正是最需要恢复的场景。
    if (info.state !== 'interrupted' && info.state !== 'processing') {
      throw new HarnessError(
        'input_error',
        `会话状态为 ${info.state}，无需恢复流程（completed / failed 直接以新 query 继续即可）`,
        { where: 'session/manager' },
      );
    }

    const checkpoint = this.store.loadLatestCheckpoint(sessionId);
    if (checkpoint === undefined) {
      throw new HarnessError('input_error', `会话无检查点记录，无法恢复：${sessionId}`, {
        where: 'session/manager',
      });
    }

    // 补位（幂等：已补过的快照推导 pending 必为空 → 不会重复写入）
    const { messages: filledMessages, filled } = fillInterruptedToolResults(checkpoint.messages);
    if (filled.length > 0) {
      const delta = filledMessages.slice(checkpoint.messages.length);
      const newCheckpoint = { id: `cp_${randomUUID()}`, turn: checkpoint.turn, messages: filledMessages };
      this.store.commit({
        sessionId,
        deltaMessages: delta,
        checkpoint: newCheckpoint,
        state: undefined, // 状态由下方统一处理（数据先行、状态殿后）
        keepLast: this.config.session.checkpoint.keepLast,
      });
      for (const message of delta) {
        this.bus.emit({ type: 'message_persisted', role: message.role, sessionId });
      }
      this.bus.emit({
        type: 'checkpoint_saved',
        checkpointId: newCheckpoint.id,
        turn: newCheckpoint.turn,
        sessionId,
      });
    }

    if (info.state === 'processing') {
      // 崩溃残留：显式标记为 interrupted（「确实中断过、现已就绪」）
      this.transition(sessionId, 'interrupted');
    }

    this.bus.emit({ type: 'session_resumed', checkpointId: checkpoint.id, sessionId });
    return {
      sessionId,
      checkpointId: checkpoint.id,
      turn: checkpoint.turn,
      messageCount: filledMessages.length,
      filledToolCallIds: filled.map((call) => call.id),
    };
  }

  // -------------------------------------------------------------------------
  // query 编排（核心）
  // -------------------------------------------------------------------------

  /**
   * 在当前会话中发起一次 query（一次用户提问）。
   *
   * 实现要点（按调用顺序）：
   *   1. 并发保护：同一会话同时只允许一条 query（running 集合）；
   *   2. 状态 → processing（先状态后数据：崩溃残留 processing 无害，见纪律①）；
   *   3. 读持久化历史 → 驱动 Loop，onTurnEnd 快照经 commitPoint 原子落盘；
   *   4. 终结：终态映射（aborted → interrupted，其余 → completed），
   *      最终差量与终态一次原子提交（纪律②）；
   *   5. 异常：状态 → failed（兜底保护，不掩盖原始异常），原样上抛。
   *
   * 产出：原样透传 LoopEvent 事件流（CLI 渲染）；终态 = completed 信封中的
   * LoopResult（generator 的 return 值同样携带，两种消费方式均可）。
   */
  async *runQuery(
    sessionId: string,
    input: string,
    signal: AbortSignal,
  ): AsyncGenerator<LoopEvent, LoopResult, void> {
    this.requireInfo(sessionId);
    if (this.running.has(sessionId)) {
      throw new HarnessError('internal_error', `会话正在运行中，拒绝并发 query：${sessionId}`, {
        where: 'session/manager',
      });
    }
    this.running.add(sessionId);

    const queryId = `q_${randomUUID()}`;
    const ctx: LoopContext = {
      sessionId,
      queryId,
      workingDir: this.workingDir,
      signal,
    };

    /** 已持久化的消息条数（per-query 闭包状态——这正是 LoopRunOptions 为调用级的原因） */
    let persistedCount = 0;
    let result: LoopResult | undefined;

    try {
      this.transition(sessionId, 'processing');

      const history = this.store.loadMessages(sessionId);
      persistedCount = history.length;

      const runOptions: LoopRunOptions = {
        // 记忆检索（w11）：每 query 一次，结果作为 profile/task 注入每轮透传。
        // memory 未装配 / enabled=false / 无命中 / 检索失败 → 均为空注入。
        injections: this.memory?.retrieveFor(input, { sessionId, queryId }),
        onTurnEnd: (snapshot) => {
          persistedCount = this.commitPoint({
            sessionId,
            queryId,
            messages: snapshot.messages,
            persistedCount,
            turn: snapshot.turn,
            isFinal: false,
          });
        },
      };

      for await (const event of this.loop.run(input, history, ctx, runOptions)) {
        if (event.type === 'completed') {
          result = event.result;
        }
        yield event;
      }

      if (result === undefined) {
        // 契约破坏（Loop 正常路径必产出 completed 信封）——防御性断言
        throw new HarnessError('internal_error', 'AgentLoop 未产出 completed 终态信封', {
          where: 'session/manager',
        });
      }

      // 终结：最终差量 + 终态一次原子提交（纪律②）
      const finalState: SessionState = result.stopReason === 'aborted' ? 'interrupted' : 'completed';
      this.commitPoint({
        sessionId,
        queryId,
        messages: result.messages,
        persistedCount,
        turn: result.turns,
        isFinal: true,
        finalState,
      });

      // ---- 记忆触发检查（w11）：回答已回写 session 之后（数据流图顺序）。
      // 只在正常终结路径（completed / aborted / max_turns 收敛于此）；
      // 异常路径（failed）不触发——「一半的对话」里提取的「记忆」没有可信度。
      // considerWrite 自吞异常（记忆是增强不是核心路径），无需 try-catch。
      this.memory?.considerWrite({
        sessionId,
        queryId,
        input,
        finalText: result.finalMessage?.content,
        stopReason: result.stopReason,
      });

      return result;
    } catch (raw) {
      // 异常路径：状态 → failed。保护性处理：状态写入自身的失败不能掩盖原始异常。
      try {
        this.transition(sessionId, 'failed');
      } catch {
        // 忽略（原始异常才是要传播的）
      }
      throw raw instanceof HarnessError ? raw : toHarnessError(raw, 'session/manager');
    } finally {
      this.running.delete(sessionId);
    }
  }

  // -------------------------------------------------------------------------
  // 内部实现
  // -------------------------------------------------------------------------

  /** 读取会话或抛 input_error（调用面统一的「会话必须存在」前置） */
  private requireInfo(sessionId: string): SessionInfo {
    const info = this.store.getSession(sessionId);
    if (info === undefined) {
      throw new HarnessError('input_error', `会话不存在：${sessionId}`, { where: 'session/manager' });
    }
    return info;
  }

  /** 状态迁移 + 事件（幂等：状态未变时不写库不发事件） */
  private transition(sessionId: string, to: SessionState): void {
    const from = this.requireInfo(sessionId).state;
    if (from === to) return;
    this.store.updateState(sessionId, to);
    this.bus.emit({ type: 'session_state_change', from, to, sessionId });
  }

  /**
   * 一次「一致点提交」：消息差量 + 检查点（按模式）+ 可选终态，
   * 经 store.commit 原子落盘；成功后才上报事件（先事实、后观测）。
   *
   * @returns 提交后的消息总数（作为下一次差量计算的基线）
   */
  private commitPoint(args: {
    readonly sessionId: string;
    readonly queryId: string;
    readonly messages: readonly Message[];
    readonly persistedCount: number;
    readonly turn: number;
    readonly isFinal: boolean;
    readonly finalState?: SessionState | undefined;
  }): number {
    const mode = this.config.session.checkpoint.mode;
    // manual 模式：仅终结时留一个检查点（「显式调用」在 v1 即 query 终结）；
    // every_turn / after_tool（降级）在每个一致点都存——对齐 CheckpointConfig 注释。
    const shouldCheckpoint = mode !== 'manual' || args.isFinal;
    const checkpoint = shouldCheckpoint
      ? { id: `cp_${randomUUID()}`, turn: args.turn, messages: args.messages }
      : undefined;

    const delta = args.messages.slice(args.persistedCount);
    const from = args.finalState !== undefined ? this.requireInfo(args.sessionId).state : undefined;

    this.store.commit({
      sessionId: args.sessionId,
      deltaMessages: delta,
      checkpoint,
      state: args.finalState,
      keepLast: this.config.session.checkpoint.keepLast,
    });

    // ---- 事件上报（commit 成功后：事件描述事实，事实先于观测存在）----
    for (const message of delta) {
      this.bus.emit({
        type: 'message_persisted',
        role: message.role,
        sessionId: args.sessionId,
        queryId: args.queryId,
      });
    }
    if (checkpoint !== undefined) {
      this.bus.emit({
        type: 'checkpoint_saved',
        checkpointId: checkpoint.id,
        turn: checkpoint.turn,
        sessionId: args.sessionId,
        queryId: args.queryId,
      });
    }
    if (args.finalState !== undefined && from !== undefined && from !== args.finalState) {
      this.bus.emit({
        type: 'session_state_change',
        from,
        to: args.finalState,
        sessionId: args.sessionId,
        queryId: args.queryId,
      });
    }

    return args.messages.length;
  }
}
