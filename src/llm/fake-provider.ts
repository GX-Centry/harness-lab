/**
 * FakeProvider —— 确定性的「一等公民」假模型（铁律 2：确定性优先）。
 *
 * 定位（对齐 zero2Agent / agent-api-lab 方法论）：
 *   它不是测试替身（mock），而是默认运行环境。整个 Harness 的测试、演示、
 *   场景断言都建立在一个完全可预测的模型之上——离线、零成本、每次相同。
 *   真实 Provider 是「可选接入」；Fake 是「必选地基」。
 *
 * 工作原理：脚本回放。
 *   构造时给一份按顺序消费的回合脚本（FakeTurn[]），每次 complete/stream
 *   取下一回合并回放。每个回合可以是：
 *     - 正常回合：文本 + 工具调用（自动推导 stopReason / usage）；
 *     - 失败回合：模拟 provider 错误（测重试与降级路径）。
 *
 * 确定性保证：
 *   - 相同脚本 + 相同调用序列 → 逐字节相同的事件流（含分片边界）；
 *   - tool_call id 由「回合序号 + 调用序号」生成，不含随机数；
 *   - 时间只出现在可注入的 sleep（默认零延迟，不触发）。
 *
 * 两种「选回合」策略（互补，可混用）：
 *   - 顺序回放（script）：按序消费——测试与场景断言的精确控制方式（默认）；
 *   - 规则匹配（rules，w17 解冻）：按「最后一条 user 消息」匹配选择回合——
 *     适合对话式演示（同样输入永远同样回复）；回合可静态给出，也可用函数
 *     按请求状态动态生成（如「工具结果刚回来 → 出总结回合」）。
 *     混用时**规则优先**；无命中回落 script；两者都没有 → provider_error。
 *
 * 教学扩展点（注释保留、暂不实现）：
 *   - 速率限制模拟：按事件数窗口限流（测 rate_limit_error 路径）。
 *
 * 依赖方向：llm/fake-provider.ts → stream-assembler / retry(sleep) / types / errors。
 */

import { HarnessError } from '../errors.ts';
import type { HarnessErrorCode } from '../errors.ts';
import type { LLMProvider, LLMRequest, LLMResponse, StreamEvent, StopReason, Usage } from '../types.ts';
import { assembleStream } from './stream-assembler.ts';
import { sleep as defaultSleep } from './retry.ts';
import { estimateTokens } from './token-estimate.ts';

// ===========================================================================
// §1 脚本形状
// ===========================================================================

/** 脚本里的工具调用声明：args 缺省为 {}（无参调用） */
export interface FakeToolCallSpec {
  readonly name: string;
  readonly args?: unknown;
}

/** 正常回合 */
export interface FakeOkTurn {
  /** 文本回复（流式回放时按 chunkSize 分片） */
  readonly text?: string;
  /** 本回合发起的工具调用（回放时按 id 配对 start/delta/end） */
  readonly toolCalls?: readonly FakeToolCallSpec[];
  /** 显式指定停止原因；缺省推导：有工具调用 → 'tool_use'，否则 'end_turn' */
  readonly stopReason?: StopReason;
  /** 显式指定用量；缺省按近似计数推导（见 deriveUsage） */
  readonly usage?: Usage;
}

/** 失败回合：在产出任何事件前抛出（模拟「连接建立期失败」） */
export interface FakeFailTurn {
  readonly fail: {
    readonly code: HarnessErrorCode;
    readonly message: string;
  };
}

export type FakeTurn = FakeOkTurn | FakeFailTurn;

function isFailTurn(turn: FakeTurn): turn is FakeFailTurn {
  return 'fail' in turn;
}

/**
 * 规则回合的两种形态：静态数据，或按请求动态生成（函数能读到完整 messages——
 * 这是「同一句输入、不同对话阶段返回不同回合」的表达力来源）。
 */
export type FakeRuleTurn = FakeTurn | ((req: LLMRequest) => FakeTurn);

/** 规则：按最后一条 user 消息选择回合（首个命中者胜出） */
export interface FakeRule {
  /**
   * 匹配目标：字符串 = 子串包含；正则 = test（自动防御 /g /y 的 lastIndex 残留）。
   * 空字符串恒命中——作为兜底规则的惯用法（match: '' 放数组末尾）。
   */
  readonly match: string | RegExp;
  /** 命中的回合（静态或动态，见 FakeRuleTurn） */
  readonly turn: FakeRuleTurn;
}

export interface FakeProviderOptions {
  /** 按顺序消费的回合脚本；耗尽后调用报 provider_error（提示脚本没写全） */
  readonly script: readonly FakeTurn[];
  /**
   * 规则表（w17 解冻）：按最后一条 user 消息匹配，首个命中者胜出；
   * 无命中回落 script 顺序消费。与 script 可混用（规则优先）。
   */
  readonly rules?: readonly FakeRule[];
  /**
   * 流分片大小（字符）。默认 8。
   * 调小 → 更碎的 delta，更能暴露组装器 bug；测试组装逻辑时可用 1 制造极端分片。
   */
  readonly chunkSize?: number;
  /** 分片间延迟（毫秒，默认 0）。>0 时用于演示流式渐进效果（sleep 可注入） */
  readonly chunkDelayMs?: number;
  /** 注入 sleep（默认 setTimeout 包装）：测试注入即时实现可零等待 */
  readonly sleep?: (ms: number) => Promise<void>;
}

// ===========================================================================
// §2 Provider 实现
// ===========================================================================

export class FakeProvider implements LLMProvider {
  readonly name = 'fake';

  private readonly script: readonly FakeTurn[];
  private readonly rules: readonly FakeRule[];
  private readonly chunkSize: number;
  private readonly chunkDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  /** 已消费的回合数（= 下次取脚本的下标）；测试断言「调用了几次模型」用 */
  private turnIndex = 0;

  /**
   * 已服务的回合数（规则命中与脚本消费**统一计数**）。
   * 用途：工具调用 id 的唯一性与确定性（id 不能依赖「脚本下标」——规则回合
   * 没有下标）。纯脚本模式下它与 turnIndex 同步递增，故既有 id 序列不变。
   */
  private servedTurns = 0;

  /** 收到的全部请求记录：测试用它断言「发给模型的上下文长什么样」（Context 测试的利器） */
  private readonly recordedRequests: LLMRequest[] = [];

  constructor(options: FakeProviderOptions) {
    this.script = options.script;
    this.rules = options.rules ?? [];
    this.chunkSize = options.chunkSize ?? 8;
    this.chunkDelayMs = options.chunkDelayMs ?? 0;
    this.sleep = options.sleep ?? defaultSleep;
  }

  get consumedTurns(): number {
    return this.turnIndex;
  }

  get requests(): readonly LLMRequest[] {
    return this.recordedRequests;
  }

  /**
   * 非流式调用 = 内部跑一遍完整流再组装。
   * 为什么这样实现：两条路径行为**严格一致**（断言只需写一份语义），
   * 也顺带把 StreamAssembler 放在唯一的必经路径上吃自己的狗粮。
   */
  async complete(req: LLMRequest): Promise<LLMResponse> {
    const result = await assembleStream(this.stream(req));
    return { message: result.message, stopReason: result.stopReason, usage: result.usage };
  }

  /**
   * 流式回放：把当前回合翻译为事件序列。
   * 事件顺序（与真实模型行为对齐）：文本分片 →（每个工具调用的 start/delta/end）→ message_end。
   */
  async *stream(req: LLMRequest): AsyncIterable<StreamEvent> {
    this.recordedRequests.push(req);
    const { turn, index } = this.takeNextTurn(req);

    if (isFailTurn(turn)) {
      // 在产出任何事件之前抛出：与「真实网络在连接建立期失败」的语义一致，
      // 也让 withRetry 的重试判定（首事件前 = 可安全重试）成立。
      throw new HarnessError(turn.fail.code, turn.fail.message, { where: 'llm/fake-provider' });
    }

    const text = turn.text ?? '';
    const toolCalls = turn.toolCalls ?? [];
    const stopReason: StopReason = turn.stopReason ?? (toolCalls.length > 0 ? 'tool_use' : 'end_turn');

    // ---- 1) 文本分片（按 code point 切，不切开 emoji 等代理对） ----
    for (const chunk of splitChunks(text, this.chunkSize)) {
      this.throwIfAborted(req);
      await this.maybeDelay();
      yield { type: 'text_delta', text: chunk };
    }

    // ---- 2) 工具调用：每个调用走完整的 start → delta* → end 生命周期 ----
    for (const [callIndex, spec] of toolCalls.entries()) {
      const id = `fc_${index}_${callIndex}`; // 确定性 id：回合序号 + 调用序号
      const argsRaw = JSON.stringify(spec.args ?? {});
      yield { type: 'tool_call_start', id, name: spec.name };
      for (const chunk of splitChunks(argsRaw, this.chunkSize)) {
        this.throwIfAborted(req);
        await this.maybeDelay();
        yield { type: 'tool_call_delta', id, argsDelta: chunk };
      }
      yield { type: 'tool_call_end', id };
    }

    // ---- 3) 收尾：停止原因与用量 ----
    const usage = turn.usage ?? this.deriveUsage(req, text, toolCalls);
    yield { type: 'message_end', stopReason, usage };
  }

  /** token 近似计数：公式共享于 llm/token-estimate.ts（真实 Provider 用同一近似） */
  countTokens(text: string): number {
    return estimateTokens(text);
  }

  // -------------------------------------------------------------------------
  // 内部实现
  // -------------------------------------------------------------------------

  private takeNextTurn(req: LLMRequest): { turn: FakeTurn; index: number } {
    // ---- 规则优先（w17）：对话式演示的选回合策略（首个命中者胜出）----
    if (this.rules.length > 0) {
      const content = lastUserContent(req);
      if (content !== undefined) {
        for (const rule of this.rules) {
          if (!matchesRule(rule.match, content)) continue;
          // 动态形态：函数能读到请求全貌（如「最后一条是工具结果 → 总结回合」）
          const turn = typeof rule.turn === 'function' ? rule.turn(req) : rule.turn;
          return { turn, index: this.servedTurns++ };
        }
      }
    }

    // ---- 顺序回放（原语义）：测试与场景断言的精确控制方式 ----
    const index = this.turnIndex;
    const turn = this.script[index];
    if (turn === undefined) {
      throw new HarnessError(
        'provider_error',
        `FakeProvider 无回合可用（规则未命中且脚本已耗尽：已消费 ${index} 轮）。` +
          '请补 rules / script 覆盖本次模型调用。',
        { where: 'llm/fake-provider' },
      );
    }
    this.turnIndex += 1;
    return { turn, index: this.servedTurns++ };
  }

  /** 用量推导：输入 = 全部消息内容 + 工具声明；输出 = 文本 + 参数 JSON */
  private deriveUsage(req: LLMRequest, outputText: string, toolCalls: readonly FakeToolCallSpec[]): Usage {
    const inputParts: string[] = [];
    for (const m of req.messages) inputParts.push(m.content);
    for (const spec of req.tools ?? []) {
      inputParts.push(`${spec.name} ${spec.description} ${JSON.stringify(spec.inputSchema)}`);
    }
    const outputRaw = outputText + toolCalls.map((s) => JSON.stringify(s.args ?? {})).join('');
    return {
      inputTokens: this.countTokens(inputParts.join('\n')),
      outputTokens: this.countTokens(outputRaw),
    };
  }

  /** 协作式取消：真实 Provider 把 signal 传给 http 客户端；Fake 在事件粒度检查 */
  private throwIfAborted(req: LLMRequest): void {
    if (req.signal?.aborted === true) {
      throw new DOMException('FakeProvider 请求被取消', 'AbortError');
    }
  }

  private async maybeDelay(): Promise<void> {
    if (this.chunkDelayMs > 0) {
      await this.sleep(this.chunkDelayMs);
    }
  }
}

// ===========================================================================
// §3 工具函数
// ===========================================================================

/**
 * 把文本切成固定大小的分片。
 * 用 Array.from 按 code point 切分——直接 slice 会切开 emoji 的代理对，
 * 产出「半个字符」的分片（经典 UTF-16 坑，真实的 token 流不会这样切）。
 */
function* splitChunks(text: string, size: number): Generator<string> {
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i += size) {
    yield chars.slice(i, i + size).join('');
  }
}

/** 最后一条 user 消息的内容（没有则 undefined——如空历史边界） */
function lastUserContent(req: LLMRequest): string | undefined {
  for (let i = req.messages.length - 1; i >= 0; i -= 1) {
    const message = req.messages[i];
    if (message !== undefined && message.role === 'user') return message.content;
  }
  return undefined;
}

/** 规则匹配：字符串 = 子串包含；正则 = test（先清 lastIndex，防 /g /y 状态残留） */
function matchesRule(match: string | RegExp, content: string): boolean {
  if (typeof match === 'string') return content.includes(match);
  match.lastIndex = 0;
  return match.test(content);
}
