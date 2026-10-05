/**
 * AgentLoop —— 内核的心脏：一次 query 的完整生命周期。
 *
 * 定位（对齐 01-architecture §3 数据流）：
 *   把「用户提问 → 回答完成」之间的 (2)~(7) 步收敛成一个可穷尽测试的
 *   async generator。它是唯一持有「消息历史 + 轮次计数 + 累计用量」的模块——
 *   其余模块都是无状态服务，由本循环编排。
 *
 * 循环全景（一轮 = 一次模型调用 + 其触发的全部工具执行）：
 *
 *   run(input, history, ctx)
 *     │
 *     ├─ while(true) ─────────────────────────────────────────────────┐
 *     │   0. 取消检查（signal.aborted）→ 轮次预算检查（maxTurns 硬约束） │
 *     │   1. (2) 组装请求  ← buildMessages()（w09 ContextMgr + w11 注入透传） │
 *     │   2. (3) provider.stream()：文本增量即到即显；                  │
 *     │         StreamAssembler 攒出完整 assistant 消息                 │
 *     │   3. (4) 无 tool_calls → 自然终结（completed）                  │
 *     │   4. (5) 对每个 tool_call → Dispatcher 四步执行链               │
 *     │   5. (6) 工具结果 → tool 消息写回历史                           │
 *     │   6. (7) 回到循环头部                                           │
 *     └────────────────────────────────────────────────────────────────┘
 *     │
 *     ├─ finally: query_end 事件（含真实终止原因，异常路径也记账）
 *     └─ yield completed 信封 + return LoopResult
 *
 * 六个关键设计决策（后续 grill 的高频问题，先在此备案）：
 *
 *   ① 为什么 async generator 而不是「回调 / 返回 Promise + 事件订阅」？
 *      - 背压：消费方（CLI 渲染）处理完一个分片才会请求下一个，
 *        生产速度与消费速度自动对齐，循环内部无需缓冲队列；
 *      - 终态信封：return 值携带 LoopResult，for-await 与手动 next()
 *        两种消费方式都能拿到完整结果；
 *      - 测试友好：collect 一下就是确定性的事件数组。
 *
 *   ② LoopEvent（yield）与 HarnessEvent（EventBus）的分工：
 *      - LoopEvent：**面向用户的对话流**——文本增量、工具活动、终态。
 *        CLI 只消费它就能渲染全过程；
 *      - HarnessEvent：**面向系统的诊断流**——请求/响应/用量/权限等
 *        细粒度事实，供可观测层（w14）订阅。
 *      两条通道内容有意重叠（如工具活动），但消费者与精度完全不同：
 *      前者是「给人看」，后者是「给机器记账」。
 *
 *   ③ 工具串行执行（v1 的刻意选择）：
 *      同一 assistant 消息里的多个 tool_call **串行**执行。理由：
 *        - 事件顺序可预测（tool_started/finished 严格成对、不交错），
 *          审计与 repeat-guard 等有状态 hook 的语义保持简单；
 *        - 并发执行是明确的演进点（对齐 w13 并发池）：届时需要处理
 *          「部分成功 + 部分取消」的合并语义，应放进专门模块，
 *          而不是在这里引入交错状态机。
 *
 *   ④ 错误分类学（Loop 是「模型不可见错误」的边界）：
 *      - 工具层错误：Dispatcher 已收敛为 ToolResult 注入历史
 *        （模型可见 → 可自我修正）；
 *      - LLM 层致命错误（provider_error 重试耗尽、组装协议违规）：
 *        **异常向上抛**——模型无法看到「模型自己挂了」，把它伪装成
 *        一条消息没有意义，只会污染对话历史；
 *      - 取消（AbortError）：控制流。Loop 捕获后收敛为 aborted 终态，
 *        不向上抛（调用方拿到的是「用户主动停止」而非「系统故障」）。
 *
 *   ⑤ 取消时的消息协议完整性（最容易被忽略的坑）：
 *      历史里 assistant 消息声明了 N 个 tool_calls，就必须有 N 条 tool
 *      结果配对——否则下一轮请求会被真实 Provider 拒绝（Anthropic 对
 *      tool_use/tool_result 配对是强校验）。所以取消发生在工具执行中时，
 *      要为「当前 + 剩余」调用补占位结果（见 step 5 的 catch 分支）。
 *
 *   ⑥ 轮次边界的持久化接缝（w10 引入）：
 *      run 的第 4 参数 LoopRunOptions.onTurnEnd 在「每轮工具批完成、结果
 *      写回历史后」回调一份只读快照（turn + messages）。Loop 不知道
 *      Session 的存在——依赖倒置：持久化策略由调用方（SessionManager）
 *      决定，Loop 只负责在正确的时机交出一致状态。最终轮（无工具调用）
 *      不回调——它的一致状态由 LoopResult.messages 统一交付；两条路径
 *      合起来覆盖全部「可落盘时刻」。
 *
 *   ⑦ 注入透传的依赖倒置（w11 引入）：
 *      LoopRunOptions.injections 是「调用方算好的 profile/task 文本」
 *      （Memory 检索结果）——检索发生在装配层（SessionManager 每 query
 *      一次），Loop 只是每轮把它转交给 ContextManager 的 assemble。与
 *      决策⑥同理：内核不认识 Memory，却为它留了通路；未来「每轮动态
 *      检索」只需在装配层改写这个字段的来源，内核零改动。
 *
 * 重试策略备注（w05 决策的延续）：
 *   流式调用**不做自动重试**——流中途失败重放会导致重复输出。安全的
 *   重试边界是「未收到任何事件」，该策略（首事件前重放）作为演进点
 *   保留在此注释、暂不实现；complete 路径的重试见 llm/retry.ts。
 *
 * 依赖方向：kernel/agent-loop.ts → llm / tools / dispatcher / events / types / errors / config。
 */

import type { HarnessConfig } from '../config.ts';
import type { ContextInjections, ContextManager } from '../context/manager.ts';
import { isAbortError, toHarnessError } from '../errors.ts';
import type { AssemblyResult } from '../llm/stream-assembler.ts';
import { StreamAssembler } from '../llm/stream-assembler.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type {
  AssistantMessage,
  LLMProvider,
  LLMRequest,
  LoopStopReason,
  Message,
  ToolResult,
  ToolSpec,
  Usage,
} from '../types.ts';
import { systemMessage, toolMessage, userMessage } from '../types.ts';
import type { Dispatcher } from './dispatcher.ts';
import type { EventBus } from './events.ts';

// ===========================================================================
// §1 输出契约
// ===========================================================================

/**
 * Loop 产出的事件流（yield 给调用方）——「面向用户的对话流」。
 *
 * 形状与 StreamEvent 的文本成员刻意一致（text_delta / thinking_delta）：
 * 转发流式分片时零转换，消费方能一鱼两吃。
 */
export type LoopEvent =
  | { readonly type: 'turn_started'; readonly turn: number }
  | { readonly type: 'text_delta'; readonly text: string }
  | { readonly type: 'thinking_delta'; readonly text: string } // 展示用；不注入历史（组装器同样丢弃）
  | {
      readonly type: 'tool_started';
      readonly toolCallId: string;
      readonly name: string;
      readonly args: unknown;
    }
  | {
      readonly type: 'tool_finished';
      readonly toolCallId: string;
      readonly name: string;
      readonly result: ToolResult;
    }
  /** 终态信封：让「for-await 简单消费」的调用方也能拿到完整结果 */
  | { readonly type: 'completed'; readonly result: LoopResult };

/** 一次 query 的最终产物 */
export interface LoopResult {
  /** 为什么终止（见 types.ts LoopStopReason 的四值语义） */
  readonly stopReason: LoopStopReason;
  /** 实际消费的轮次（模型调用次数） */
  readonly turns: number;
  /** 本 query 的累计用量（各轮之和） */
  readonly usage: Usage;
  /**
   * 最终完整消息历史（含 system / user / assistant / tool）。
   * 供 Session 持久化（w10）与调用方读取；类型只读，约定调用方不再修改。
   */
  readonly messages: readonly Message[];
  /** 最后一条 assistant 消息（回答；aborted 时可能是半截或 undefined） */
  readonly finalMessage: AssistantMessage | undefined;
}

/**
 * 轮次快照 —— Loop 与「持久化消费方」（SessionManager）之间的接缝载体。
 * 语义：snapshot 描述的是「一个**一致点**」——此刻 messages 中
 * assistant(tool_calls) 与全部 tool 结果配对完整，任何一方落地都不会
 * 产生半个协议（这正是选在「工具批完成后」而非「批执行中」回调的原因）。
 */
export interface LoopSnapshot {
  readonly sessionId: string;
  readonly queryId: string;
  /** 已完成的轮次数（从 1 开始计数） */
  readonly turn: number;
  /**
   * 完整消息历史（含本轮工具结果）。**只读引用**：
   * 回调方必须同步消费完毕（需要留存请自行拷贝）——它指向 Loop 的
   * 内部工作数组，回调返回后内容可能继续增长。
   */
  readonly messages: readonly Message[];
}

/**
 * run() 的每次调用选项（与构造级的 AgentLoopOptions 刻意分离）。
 * 为什么是「调用级」而非「构造级」：同一条 Loop 会被多个会话/多次 query
 * 复用，而快照消费方需要 per-query 的状态（如各自已持久化的消息数）——
 * 这类状态只能来自调用闭包，不能焊死在单例构造里。
 */
export interface LoopRunOptions {
  /**
   * 每轮末尾（工具批全部写回历史后、进入下一轮前）回调。
   * 未绑定时的语义：Loop 照常运行，只是无人落盘（直传模式/单元测试）。
   */
  readonly onTurnEnd?: (snapshot: LoopSnapshot) => void;
  /**
   * profile / task 层注入（w11：Memory 检索结果；每 query 一份、每轮透传）。
   * 依赖倒置（见文件头决策 ⑦）：Loop 不知道 Memory 的存在——它只是把
   * 「调用方算好的注入」转交给 ContextManager，检索时机与内容属于装配层。
   */
  readonly injections?: ContextInjections;
}

/**
 * 运行环境（调用方注入）。
 * 与 dispatcher.DispatchContext **刻意保持同构**：结构类型系统让 ctx
 * 可以直通 dispatch()，而两个模块之间无需引入类型依赖。
 */
export interface LoopContext {
  readonly sessionId: string;
  readonly queryId: string;
  /** 工具文件操作的沙箱根目录（会话级配置，不是进程 cwd） */
  readonly workingDir: string;
  /** 协作式取消：用户中断 / 全局超时向下传播到 Provider 与所有工具 */
  readonly signal: AbortSignal;
}

// ===========================================================================
// §2 构造选项
// ===========================================================================

export interface AgentLoopOptions {
  readonly provider: LLMProvider;
  readonly dispatcher: Dispatcher;
  /** 工具注册表（Loop 用它生成每轮请求的 ToolSpec 列表） */
  readonly registry: ToolRegistry;
  readonly bus: EventBus;
  readonly config: HarnessConfig;
  /**
   * 上下文管理器（w09 接入）。缺省时为「直传模式」——不做任何压缩，
   * 原样把历史发给模型（用于隔离测试与最小装配）。
   */
  readonly contextManager?: ContextManager;
  /**
   * 系统提示词直通接缝（w09 ContextManager 到位前的临时通道）。
   * 注入规则：history 首位已是 system 消息时不重复注入（幂等）。
   * 演进：w09 之后 system 层由 ContextManager 统一组装，本选项降级为
   * 「初始 system 内容的来源」。
   */
  readonly systemPrompt?: string;
  /** 时钟注入（latencyMs 计算；默认 Date.now） */
  readonly now?: () => number;
}

// ===========================================================================
// §3 AgentLoop 实现
// ===========================================================================

export class AgentLoop {
  private readonly provider: LLMProvider;
  private readonly dispatcher: Dispatcher;
  private readonly registry: ToolRegistry;
  private readonly bus: EventBus;
  private readonly config: HarnessConfig;
  private readonly contextManager: ContextManager | undefined;
  private readonly systemPrompt: string | undefined;
  private readonly now: () => number;

  constructor(options: AgentLoopOptions) {
    this.provider = options.provider;
    this.dispatcher = options.dispatcher;
    this.registry = options.registry;
    this.bus = options.bus;
    this.config = options.config;
    this.contextManager = options.contextManager;
    this.systemPrompt = options.systemPrompt;
    this.now = options.now ?? Date.now;
  }

  /**
   * 运行一次 query。
   *
   * @param input   用户输入（本轮新增的 user 消息文本）
   * @param history 之前的完整消息历史（来自 Session 的持久化历史，w10 已接入）
   * @param ctx     运行环境（sessionId / queryId / workingDir / signal）
   * @param runOptions 调用级选项（onTurnEnd 持久化接缝；缺省为无人落盘模式）
   *
   * 消费方式（两种等价）：
   *   1. for await 逐事件处理（CLI 渲染路径）——终态从 completed 信封取；
   *   2. 手动 next() 循环——终态从 generator 的 return 值取（测试路径）。
   */
  async *run(
    input: string,
    history: readonly Message[],
    ctx: LoopContext,
    runOptions: LoopRunOptions = {},
  ): AsyncGenerator<LoopEvent, LoopResult, void> {
    // ---- 工作副本：Loop 是唯一可变拥有者 ----
    const messages: Message[] = [...history];
    if (this.systemPrompt !== undefined && !messages.some((m) => m.role === 'system')) {
      messages.unshift(systemMessage(this.systemPrompt));
    }
    messages.push(userMessage(input));

    // 工具声明列表：每轮请求都携带（真实 Provider 支持 prompt 缓存时，
    // 稳定不变的声明列表是缓存命中的前提——保持注册顺序即可）。
    const toolSpecs: readonly ToolSpec[] = this.registry.toToolSpecs();

    const usageTotals = { inputTokens: 0, outputTokens: 0 };
    let turns = 0;
    let stopReason: LoopStopReason = 'completed';
    let finalAssistant: AssistantMessage | undefined;

    this.bus.emit({
      type: 'query_start',
      inputLength: input.length, // 隐私约定：只记长度，原文不入事件
      sessionId: ctx.sessionId,
      queryId: ctx.queryId,
    });

    try {
      while (true) {
        // ---- 0. 两个硬约束检查（顺序：取消优先于预算）----
        if (ctx.signal.aborted) {
          stopReason = 'aborted';
          break;
        }
        if (turns >= this.config.loop.maxTurns) {
          stopReason = 'max_turns';
          break;
        }
        turns += 1;
        yield { type: 'turn_started', turn: turns };

        // ---- 1. (2) 组装请求 ----
        const request: LLMRequest = {
          model: this.config.llm.defaultModel,
          messages: this.buildMessages(messages, ctx, runOptions.injections),
          tools: toolSpecs,
          // 输出预留预算就是给这里用的：限制单轮输出长度，防止一卦把上下文撑爆
          maxOutputTokens: this.config.context.reservedOutputTokens,
          signal: ctx.signal,
        };
        this.bus.emit({
          type: 'llm_request',
          model: request.model,
          messageCount: request.messages.length,
          toolCount: toolSpecs.length,
          approxInputTokens: this.estimateInputTokens(request.messages),
          sessionId: ctx.sessionId,
          queryId: ctx.queryId,
        });

        // ---- 2. (3) 流式调用：转发给用户 + 组装为完整消息 ----
        const startedAt = this.now();
        const assembler = new StreamAssembler();
        let assembled: AssemblyResult;
        try {
          for await (const event of this.provider.stream(request)) {
            switch (event.type) {
              case 'text_delta':
                // 即到即显：先 yield 给调用方，再喂给组装器（两者都要）
                yield { type: 'text_delta', text: event.text };
                break;
              case 'thinking_delta':
                // 思考流展示给用户，但不进入对话内容（组装器接收后丢弃——见其注释）
                yield { type: 'thinking_delta', text: event.text };
                break;
              default:
                // 其余事件（tool_call_start/delta/end、message_end）只进组装器：
                // 工具调用的中间态没有展示价值，最终形态由 assembled.message 表达。
                break;
            }
            assembler.feed(event);
          }
          assembled = assembler.finish();
        } catch (raw) {
          if (isAbortError(raw)) {
            stopReason = 'aborted';
            break;
          }
          // 致命错误：记账后向上抛（语义见文件头决策 ④）
          stopReason = 'error';
          throw toHarnessError(raw, 'kernel/agent-loop');
        }

        usageTotals.inputTokens += assembled.usage.inputTokens;
        usageTotals.outputTokens += assembled.usage.outputTokens;
        this.bus.emit({
          type: 'llm_response',
          model: request.model,
          stopReason: assembled.stopReason,
          usage: assembled.usage,
          toolCallCount: assembled.message.toolCalls?.length ?? 0,
          latencyMs: this.now() - startedAt,
          sessionId: ctx.sessionId,
          queryId: ctx.queryId,
        });

        messages.push(assembled.message);
        finalAssistant = assembled.message;

        // ---- 3. (4) 无工具调用 → 自然终结 ----
        const toolCalls = assembled.message.toolCalls ?? [];
        if (toolCalls.length === 0) {
          stopReason = 'completed';
          break;
        }

        // ---- 4. (5) 逐工具执行（串行，理由见文件头决策 ③）----
        let abortedMidTurn = false;
        for (let i = 0; i < toolCalls.length; i += 1) {
          const call = toolCalls[i];
          if (call === undefined) continue; // noUncheckedIndexedAccess 护栏（循环界内不可能发生）

          yield { type: 'tool_started', toolCallId: call.id, name: call.name, args: call.args };

          let result: ToolResult;
          try {
            result = await this.dispatcher.dispatch(call, ctx);
          } catch (raw) {
            if (!isAbortError(raw)) {
              stopReason = 'error';
              throw toHarnessError(raw, 'kernel/agent-loop');
            }
            // 取消发生在工具执行中：为「当前 + 剩余」调用补占位结果，
            // 维持 history 里 assistant(tool_calls) ↔ tool(result) 的配对数
            //（决策 ⑤——否则下一轮请求会被真实 Provider 拒绝）。
            for (const pending of toolCalls.slice(i)) {
              messages.push(toolMessage(pending.id, pending.name, '（调用因会话取消而中止）'));
            }
            abortedMidTurn = true;
            break;
          }

          yield { type: 'tool_finished', toolCallId: call.id, name: call.name, result };

          // ---- 5. (6) 工具结果写回历史（精确配对：toolCallId）----
          messages.push(toolMessage(call.id, call.name, result.content));
        }
        if (abortedMidTurn) {
          stopReason = 'aborted';
          break;
        }

        // ---- 6. (7) 轮次边界：快照回调（w10 持久化接缝，见文件头决策 ⑥）----
        // 此刻 messages 处于「工具批全部写回后」的一致状态（配对完整），
        // 是最佳落盘边界——快照的消费方（SessionManager）负责原子落盘。
        runOptions.onTurnEnd?.({
          sessionId: ctx.sessionId,
          queryId: ctx.queryId,
          turn: turns,
          messages,
        });

        // ---- 7. 回到循环头部：下一轮模型调用带着工具结果继续 ----
      }
    } finally {
      // 统一记账出口：正常、取消、异常三条路径都经过这里（stopReason 语义见 LoopStopReason）
      this.bus.emit({
        type: 'query_end',
        stopReason,
        turns,
        usage: { inputTokens: usageTotals.inputTokens, outputTokens: usageTotals.outputTokens },
        sessionId: ctx.sessionId,
        queryId: ctx.queryId,
      });
    }

    const result: LoopResult = {
      stopReason,
      turns,
      usage: { inputTokens: usageTotals.inputTokens, outputTokens: usageTotals.outputTokens },
      messages,
      finalMessage: finalAssistant,
    };
    yield { type: 'completed', result };
    return result;
  }

  // -------------------------------------------------------------------------
  // 内部实现
  // -------------------------------------------------------------------------

  /**
   * (2) 上下文组装接缝 —— w09 已接入 ContextManager：
   *   分层预算（system/profile/task/history/recent）+ 压缩链 + 注入段落。
   *   注入段落（profile/task）来自 runOptions.injections（w11：Memory
   *   检索结果由装配层透传）——undefined 时 ContextManager 按空注入处理。
   *
   * 关键语义（对应 manager.ts 文件头决策 ①）：
   *   本方法产出的是**投影**——Loop 持有的 messages 完整历史不变，
   *   被压缩的只是「本次请求看到的视图」。压缩产物（占位/摘要消息）
   *   让模型知道「有东西被省略了」，而原始内容在会话存储中可恢复。
   *
   * 每轮全量重算（O(n)）：教学可接受；生产优化点见 manager.ts 文件头。
   */
  private buildMessages(
    messages: readonly Message[],
    ctx: LoopContext,
    injections: ContextInjections | undefined,
  ): Message[] {
    if (this.contextManager === undefined) {
      return [...messages]; // 直传模式：隔离测试与最小装配使用
    }
    return this.contextManager.build(
      messages,
      {
        sessionId: ctx.sessionId,
        queryId: ctx.queryId,
      },
      injections,
    ).messages;
  }

  /**
   * 输入 token 粗略估算（用于 llm_request 事件的观测字段）。
   * 只数文本 + 工具调用的原始参数 JSON；角色标签/结构开销忽略——
   * 精确预算检查是 w09 的职责（这里是「观测值」不是「决策值」）。
   */
  private estimateInputTokens(messages: readonly Message[]): number {
    let total = 0;
    for (const m of messages) {
      total += this.provider.countTokens(m.content);
      if (m.role === 'assistant' && m.toolCalls !== undefined) {
        for (const call of m.toolCalls) {
          total += this.provider.countTokens(call.argsRaw);
        }
      }
    }
    return total;
  }
}
