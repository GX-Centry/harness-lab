/**
 * 流式组装状态机（ADR-008）—— 协议层最高频 bug 的隔离墙。
 *
 * 要解决的问题（为什么必须显式状态机）：
 *   流式响应里，文本增量和 tool_call 的**参数 JSON 分片**混在一起到达。
 *   朴素实现容易犯两类经典错误：
 *     a) 攒到一半就 JSON.parse（得到「半个 JSON」）→ 随机崩溃；
 *     b) 把不同工具调用的分片攒进同一个缓冲区 → 参数串台。
 *   本模块把「如何攒、何时 parse」收敛为一个可穷尽测试的显式状态机：
 *     - text_delta        → 直接累积，可通过 onTextDelta 即到即显（UI 路径）；
 *     - tool_call_start   → 登记 id → { name, argsChunks: [] }（新的累积缓冲）；
 *     - tool_call_delta   → 按 id 追加分片（绝不提前 parse）；
 *     - tool_call_end     → 此刻参数才完整，整体 parse 一次（失败 → parseError）；
 *     - message_end       → 记录 stopReason / usage，流收尾（此后 feed 一律报错）。
 *
 * 错误分层（对齐错误分类体系，全部是可测试的确定性行为）：
 *   - **协议违规**（delta 指向未知 id / 重复 start / end 后继续收）→ internal_error：
 *     说明组装器或适配器有 bug，快速失败比默默错拼更有价值；
 *   - **流截断**（finish 时没有 message_end）→ provider_error：外部故障，可重试；
 *   - **参数 JSON 残缺**（有 end 但 parse 失败）→ 不抛错！产出 parseError 的 ToolCall，
 *     由 Dispatcher 转成 input_error 结果让模型自我修正（ADR-004「错误即数据」）；
 *   - **tool_call 未闭合但有 message_end**（协议瑕疵）→ 同上降级为 parseError。
 *
 * 使用方式：
 *   - 手动驾驶（需要读中间状态）：new StreamAssembler() + feed() + finish()；
 *   - 一行消费（多数场景）：assembleStream(provider.stream(req), { onTextDelta })。
 *
 * 依赖方向：llm/stream-assembler.ts → types.ts → errors.ts。
 */

import { HarnessError, toHarnessError } from '../errors.ts';
import { assistantMessage } from '../types.ts';
import type { AssistantMessage, StopReason, StreamEvent, ToolCall, Usage } from '../types.ts';

// ===========================================================================
// §1 产物形状
// ===========================================================================

/** 组装结果：一条完整 assistant 消息 + 停止原因 + 用量（与 LLMResponse 同构） */
export interface AssemblyResult {
  readonly message: AssistantMessage;
  readonly stopReason: StopReason;
  readonly usage: Usage;
}

export interface StreamAssemblerOptions {
  /**
   * 文本增量回调：即到即显的唯一入口（REPL / Web 的渲染挂在这里）。
   * 刻意只提供文本回调：tool_call 中途状态没有展示价值，
   * 需要看原始事件的消费者应直接用 provider.stream() 的迭代器。
   */
  readonly onTextDelta?: (text: string) => void;
}

/** 打开中的 tool_call 缓冲：name 在 start 时已知，参数分片持续追加 */
interface OpenToolCall {
  readonly name: string;
  readonly argsChunks: string[];
}

// ===========================================================================
// §2 状态机实现
// ===========================================================================

/**
 * 单流单实例：一个 StreamAssembler 只服务一条流（不并发安全）。
 * 状态集合（迁移见文件头）：
 *   textChunks[]     累积的文本分片
 *   openCalls        打开中的调用（id → 缓冲）
 *   completedCalls[] 已闭合的调用（保持到达顺序）
 *   endInfo          流结束信息；非 undefined 即「终态」
 */
export class StreamAssembler {
  private readonly textChunks: string[] = [];
  private readonly openCalls = new Map<string, OpenToolCall>();
  private readonly completedCalls: ToolCall[] = [];
  private endInfo: { readonly stopReason: StopReason; readonly usage: Usage } | undefined;
  private readonly onTextDelta: ((text: string) => void) | undefined;

  constructor(options: StreamAssemblerOptions = {}) {
    this.onTextDelta = options.onTextDelta;
  }

  /** 流是否已收尾（收到 message_end） */
  get ended(): boolean {
    return this.endInfo !== undefined;
  }

  /** 当前已累积的文本（UI 之外的测试与调试用） */
  get text(): string {
    return this.textChunks.join('');
  }

  /**
   * 喂入一个流事件。协议违规立即抛出 internal_error——
   * 「快速失败」在这里是特性：错拼的消息比崩溃更难排查。
   */
  feed(event: StreamEvent): void {
    if (this.endInfo !== undefined) {
      throw this.protocolError(`message_end 之后收到事件 ${event.type}（流已结束，状态机进入终态）`);
    }
    switch (event.type) {
      case 'text_delta':
        this.textChunks.push(event.text);
        this.onTextDelta?.(event.text);
        break;

      case 'thinking_delta':
        // 预留：推理模型的思考流。当前策略：接收但丢弃（不注入对话内容）。
        // 演进点：可累积进消息 meta、或通过回调实时展示「思考中」UI。
        break;

      case 'tool_call_start': {
        if (this.openCalls.has(event.id)) {
          throw this.protocolError(`tool_call_start 重复 id=${event.id}（该调用已打开）`);
        }
        this.openCalls.set(event.id, { name: event.name, argsChunks: [] });
        break;
      }

      case 'tool_call_delta': {
        const open = this.openCalls.get(event.id);
        if (open === undefined) {
          throw this.protocolError(`tool_call_delta 指向未打开的调用 id=${event.id}`);
        }
        open.argsChunks.push(event.argsDelta);
        break;
      }

      case 'tool_call_end': {
        const open = this.openCalls.get(event.id);
        if (open === undefined) {
          throw this.protocolError(`tool_call_end 指向未打开的调用 id=${event.id}`);
        }
        this.openCalls.delete(event.id);
        this.completedCalls.push(this.finalizeToolCall(event.id, open));
        break;
      }

      case 'message_end':
        this.endInfo = { stopReason: event.stopReason, usage: event.usage };
        break;

      default: {
        // 穷尽检查惯用法：新增 StreamEvent 成员而忘记在此处理 → 编译期报错。
        // （走到这里说明类型系统被绕过——运行期兜底同样要报错。）
        const unhandled: never = event;
        throw this.protocolError(`未知流事件: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  /**
   * 收尾并产出组装结果。调用后状态不再变化。
   *
   * 两条收尾路径：
   *   - 无 message_end → provider_error（流截断，外部故障，可重试）；
   *   - 有 message_end 但有未闭合 tool_call → 降级：转成 parseError 的 ToolCall
   *     （「带残缺参数的调用」是模型下轮需要看到的事实，不是要炸系统的异常）。
   */
  finish(): AssemblyResult {
    const end = this.endInfo;
    if (end === undefined) {
      throw new HarnessError(
        'provider_error',
        '流在 message_end 之前结束——疑似连接中断或超时（已收到的分片将被丢弃）',
        { where: 'llm/stream-assembler' },
      );
    }
    for (const [id, open] of this.openCalls) {
      this.completedCalls.push(this.finalizeToolCall(id, open, 'tool_call 未闭合：流在参数完整前被结束'));
    }
    this.openCalls.clear();
    return {
      message: assistantMessage(this.text, this.completedCalls.length > 0 ? [...this.completedCalls] : undefined),
      stopReason: end.stopReason,
      usage: end.usage,
    };
  }

  /**
   * 闭合一个 tool_call：拼接分片 → 整体 parse（仅此一次，绝无「半个 JSON」）。
   * 三种结局：
   *   - 空参数（''）→ args={}（模型对无参工具的常见表达是空串或 '{}'）；
   *   - parse 失败 → args=undefined + parseError（错误即数据）；
   *   - forcedParseError（未闭合降级）→ 同 parseError 路径。
   */
  private finalizeToolCall(id: string, open: OpenToolCall, forcedParseError?: string): ToolCall {
    const argsRaw = open.argsChunks.join('');
    if (forcedParseError !== undefined) {
      return { id, name: open.name, args: undefined, argsRaw, parseError: forcedParseError };
    }
    if (argsRaw.trim() === '') {
      return { id, name: open.name, args: {}, argsRaw };
    }
    try {
      return { id, name: open.name, args: JSON.parse(argsRaw), argsRaw };
    } catch (raw) {
      const error = toHarnessError(raw, 'llm/stream-assembler');
      return { id, name: open.name, args: undefined, argsRaw, parseError: `参数 JSON 解析失败: ${error.message}` };
    }
  }

  private protocolError(message: string): HarnessError {
    return new HarnessError('internal_error', `流协议违规: ${message}`, { where: 'llm/stream-assembler' });
  }
}

// ===========================================================================
// §3 便捷入口
// ===========================================================================

/**
 * 一行消费整个流：迭代 → feed → finish。
 * 生产路径（Loop）推荐用这个；需要中途读取状态时才手动持 StreamAssembler。
 */
export async function assembleStream(
  events: AsyncIterable<StreamEvent>,
  options: StreamAssemblerOptions = {},
): Promise<AssemblyResult> {
  const assembler = new StreamAssembler(options);
  for await (const event of events) {
    assembler.feed(event);
  }
  return assembler.finish();
}
