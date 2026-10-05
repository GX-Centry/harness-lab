/**
 * ContextManager —— 上下文组装与预算治理中心（ADR-007 的完整落地）。
 *
 * 它在数据流中的位置：AgentLoop 每一轮调用模型前，把「完整会话历史」
 * 变换为「本次请求的上下文视图」——
 *
 *   完整历史（Loop 内部拥有，永不丢失）
 *     │
 *     ├─ ① 提取 system（规范形约定在首位）
 *     ├─ ② system 注入段落组装（profile / task ← memory 层，w11 接入）
 *     ├─ ③ L1：超限的 tool 消息头尾压缩
 *     ├─ ④ 按「轮次组」分组（协议安全：assistant(tool_calls)+tool 永不拆散）
 *     ├─ ⑤ 划分 recent（尾部窗口，保精度）/ history（较早部分，可压缩）
 *     ├─ ⑥ history 层压缩链：L2 丢弃最老组 → L3 规则摘要 → L4 摘要截断
 *     └─ ⑦ 组装 + 计量 → ContextBuildResult（messages + report）
 *
 * 三个贯穿性设计决策：
 *
 *   ① 「会话历史」与「请求视图」的分离：
 *      Loop 持有的完整历史是**事实**（持久化进 Session，w10）；
 *      ContextManager 产出的请求视图是**投影**（每轮按预算重算）。
 *      压缩只作用于投影——历史永远完整，压缩造成的「记忆损失」对
 *      模型可见（占位/摘要消息），对系统可恢复（原始消息在存储里）。
 *
 *   ② 分层预算的分工（为什么不是一刀切截断）：
 *      system/profile/task 层**不压缩只警告**（行为准则与注入内容
 *      被静默截断是灾难；超了应该改配置/改代码）；
 *      history 层是压缩主战场（走 L2→L3→L4 链）；
 *      recent 层**保底至少一组**（没有任何最近上下文的对话是更严重的错误，
 *      宁可超预算也要带上——警告代替截断）。
 *
 *   ③ 纯函数式变换：
 *      build() 不修改传入的历史数组（compressToolMessage 产出新消息对象）。
 *      这保证「同一份历史 + 同一份配置 → 同一份请求视图」（确定性），
 *      也让测试可以对比「压缩前后」而无需深拷贝。
 *
 * 演进点（注释保留，暂不实现）：
 *   - LLM 摘要：替换 compressor.foldToSummaryMessage 为异步 LLM 调用
 *     （build 变为 async，签名级改动——所以「规则摘要保底」先行）；
 *   - 检索式记忆：被压缩的消息进 Memory 存储（w11），模型可按需检索原文
 *     （占位消息文案已为这条路径做了铺垫）；
 *   - 增量缓存：每轮全量重算的 O(n) 成本教学可接受；生产实现应该只在
 *     消息变化时重算受影响的层（recent 层之外的部分）。
 *
 * 依赖方向：context/manager.ts → types / config / tokens / compressor
 *           + kernel/events（仅类型——事件总线的注入依赖）。
 */

import type { ContextConfig } from '../config.ts';
import type { EventBus } from '../kernel/events.ts';
import type { Message, UserMessage } from '../types.ts';
import { systemMessage } from '../types.ts';
import { compressToolMessage, foldToSummaryMessage, omissionMessage, truncateToTokenBudget } from './compressor.ts';
import type { CompressionRecord } from './compressor.ts';
import { MESSAGE_OVERHEAD_TOKENS, messageTokens, messagesTokens } from './tokens.ts';
import type { TokenCounter } from './tokens.ts';

// ===========================================================================
// §1 输入输出契约
// ===========================================================================

/** 五个上下文层的名字（与 config.context.layers 的键一一对应） */
export type ContextLayerName = 'system' | 'profile' | 'task' | 'history' | 'recent';

/**
 * 上下文注入（profile / task 层的来源）。
 * v1：由调用方显式提供；w11 Memory 层接入后由「检索器」产生
 *（每次检索结果不同 → 所以放在 build 参数而不是构造选项）。
 */
export interface ContextInjections {
  /** 用户画像：跨会话偏好（memory 长期记忆） */
  readonly profile?: string;
  /** 任务层：本次任务相关的外部知识（memory 检索结果等） */
  readonly task?: string;
}

/** 一次组装的分层计量报告（事件与测试消费） */
export interface ContextReport {
  /** 最终消息数组的 token 总量（消息级计量，含结构开销） */
  readonly totalTokens: number;
  /** 各层 token 占用（内容级计量——system/profile/task 不含结构开销微差） */
  readonly layerTokens: Readonly<Record<ContextLayerName, number>>;
  /** 本次组装是否发生过压缩 */
  readonly compressed: boolean;
  /** 压缩链的每级动作记录 */
  readonly compressions: readonly CompressionRecord[];
  /** 不阻断流程的问题（超预算等）——可观测层应监控非空情况 */
  readonly warnings: readonly string[];
}

export interface ContextBuildResult {
  /** 最终要发给模型的消息数组（规范形：system 在首位；纯函数式变换的新数组） */
  readonly messages: Message[];
  readonly report: ContextReport;
}

/** build 的调用侧上下文（事件关联维度） */
export interface ContextBuildContext {
  readonly sessionId: string;
  readonly queryId: string;
}

export interface ContextManagerOptions {
  /** 上下文域配置（总预算 + 五层预算 + 工具输出阈值） */
  readonly config: ContextConfig;
  /** token 计数函数（与「即将调用的 Provider」同一把尺子——装配层负责） */
  readonly count: TokenCounter;
  /** 事件总线（可选：纯单元测试可以不接） */
  readonly bus?: EventBus;
}

/** 轮次组：预算处理的最小原子单位（协议安全的载体） */
interface MessageGroup {
  readonly messages: readonly Message[];
  readonly tokens: number;
}

// ===========================================================================
// §2 ContextManager 实现
// ===========================================================================

export class ContextManager {
  private readonly config: ContextConfig;
  private readonly count: TokenCounter;
  private readonly bus: EventBus | undefined;

  constructor(options: ContextManagerOptions) {
    this.config = options.config;
    this.count = options.count;
    this.bus = options.bus;
  }

  /**
   * 组装一次请求上下文。
   *
   * @param history 完整会话历史（含首位 system；Loop 内部持有的原始数组）
   * @param ctx     事件关联维度
   * @param injections profile / task 层注入（w11 后由 Memory 检索产生）
   */
  build(
    history: readonly Message[],
    ctx: ContextBuildContext,
    injections: ContextInjections = {},
  ): ContextBuildResult {
    const layers = this.config.layers;
    const warnings: string[] = [];
    const compressions: CompressionRecord[] = [];

    // ---- ① 提取 system ----
    let systemBase = '';
    let rest: readonly Message[] = history;
    const first = history[0];
    if (first !== undefined && first.role === 'system') {
      systemBase = first.content;
      rest = history.slice(1);
    }

    // ---- ② L1：工具输出预处理（每轮都做——超限的 tool 消息不该等到层超限才压缩）----
    const processed: Message[] = rest.map((message) => {
      if (message.role !== 'tool') return message;
      const { message: compressedMessage, record } = compressToolMessage(
        message,
        this.config.toolOutputMaxTokens,
        this.count,
      );
      if (record !== undefined) compressions.push(record);
      return compressedMessage;
    });

    // ---- ③ 分组（协议安全）----
    const groups = groupMessages(processed, this.count);

    // ---- ④ 划分 recent / history（recent 保底最近一组）----
    const { recentGroups, oldGroups } = this.partition(groups, layers.recent, warnings);

    // ---- ⑤ history 层压缩链 ----
    const historyMessages = this.buildHistory(oldGroups, layers.history, compressions);

    // ---- ⑥ 组装 system（本体 + 注入段落）----
    const systemContent = composeSystem(systemBase, injections);
    const messages: Message[] = [];
    if (systemContent !== '') {
      messages.push(systemMessage(systemContent));
    }
    for (const message of historyMessages) messages.push(message);
    for (const group of recentGroups) for (const message of group.messages) messages.push(message);

    // ---- ⑦ 计量 + 预算警告（不压缩只警告的三层）----
    const recentFlat = recentGroups.flatMap((group) => [...group.messages]);
    const systemTokens = this.count(systemBase);
    const profileTokens = this.count(injections.profile ?? '');
    const taskTokens = this.count(injections.task ?? '');
    if (systemTokens > layers.system) {
      warnings.push(
        `system 层超预算（${systemTokens} > ${layers.system} tok）：提示词应改代码而不是被截断（不压缩）`,
      );
    }
    if (profileTokens > layers.profile) {
      warnings.push(`profile 层超预算（${profileTokens} > ${layers.profile} tok）：注入方应控制长度（不压缩）`);
    }
    if (taskTokens > layers.task) {
      warnings.push(`task 层超预算（${taskTokens} > ${layers.task} tok）：注入方应控制长度（不压缩）`);
    }

    const layerTokens: Record<ContextLayerName, number> = {
      system: systemTokens,
      profile: profileTokens,
      task: taskTokens,
      history: messagesTokens(historyMessages, this.count),
      recent: messagesTokens(recentFlat, this.count),
    };
    const totalTokens = messagesTokens(messages, this.count);
    if (totalTokens > this.config.maxTotalTokens) {
      // best-effort：五层预算之和 <= 总预算（配置校验保证），走到这里通常
      // 意味着 system/注入层超限。不抛错——「超一点成本」比「对话不可用」轻。
      warnings.push(
        `总预算超限（${totalTokens} > ${this.config.maxTotalTokens} tok）：已尽力压缩，请检查 system/注入层`,
      );
    }

    // ---- ⑧ 事件上报 ----
    if (this.bus !== undefined) {
      for (const record of compressions) {
        this.bus.emit({
          type: 'context_compressed',
          level: record.level,
          droppedMessages: record.droppedMessages,
          droppedTokens: record.droppedTokens,
          sessionId: ctx.sessionId,
          queryId: ctx.queryId,
        });
      }
      this.bus.emit({
        type: 'context_built',
        totalTokens,
        layerTokens,
        compressed: compressions.length > 0,
        sessionId: ctx.sessionId,
        queryId: ctx.queryId,
      });
    }

    return {
      messages,
      report: {
        totalTokens,
        layerTokens,
        compressed: compressions.length > 0,
        compressions,
        warnings,
      },
    };
  }

  // -------------------------------------------------------------------------
  // 内部实现
  // -------------------------------------------------------------------------

  /**
   * recent / old 划分：从最新组往前装，装到 recent 预算为止。
   * 两个语义细节：
   *   - **保底**：最近一组无条件进入 recent（哪怕超预算）——「零最近上下文」
   *     的对话是更严重的错误；警告代替截断；
   *   - **连续性**：一旦某组装不进，更老的组一律进 old（窗口保持连续，
   *     不能出现「跳过中间组」的上下文断层）。
   */
  private partition(
    groups: readonly MessageGroup[],
    recentBudget: number,
    warnings: string[],
  ): { readonly recentGroups: MessageGroup[]; readonly oldGroups: MessageGroup[] } {
    const recentGroups: MessageGroup[] = [];
    const oldGroups: MessageGroup[] = [];
    let used = 0;
    let accepting = true;

    for (let i = groups.length - 1; i >= 0; i -= 1) {
      const group = groups[i];
      if (group === undefined) continue; // noUncheckedIndexedAccess 护栏

      if (recentGroups.length === 0) {
        // 保底：最近一组无条件保留
        recentGroups.unshift(group);
        used += group.tokens;
        if (group.tokens > recentBudget) {
          warnings.push(
            `最近一组超 recent 预算（${group.tokens} > ${recentBudget} tok）：已保底保留，建议调大 recent 预算或压缩输入`,
          );
        }
        continue;
      }

      if (accepting && used + group.tokens <= recentBudget) {
        recentGroups.unshift(group);
        used += group.tokens;
      } else {
        accepting = false;
        oldGroups.unshift(group);
      }
    }
    return { recentGroups, oldGroups };
  }

  /**
   * history 层压缩链：L2（丢弃最老组）→ L3（规则摘要）→ L4（摘要截断）。
   * 说明：L2 的「至少保留一组」是为了先试探「丢到只剩一组能否装下」；
   * 装不下才升级到 L3（全折叠）——压缩级别严格按「便宜优先」逐级升高。
   */
  private buildHistory(
    oldGroups: readonly MessageGroup[],
    historyBudget: number,
    compressions: CompressionRecord[],
  ): Message[] {
    if (oldGroups.length === 0) return [];
    const sumOf = (groups: readonly MessageGroup[]): number =>
      groups.reduce((total, group) => total + group.tokens, 0);

    // 预算内 → 原样保留（最常见的路径：无压缩）
    if (sumOf(oldGroups) <= historyBudget) {
      return flattenGroups(oldGroups);
    }

    // ---- L2：从最老开始丢弃，直到装下 ----
    const kept: MessageGroup[] = [...oldGroups];
    const dropped: MessageGroup[] = [];
    while (kept.length > 1 && sumOf(kept) > historyBudget) {
      const shifted = kept.shift();
      if (shifted === undefined) break; // 不可达（length > 1 保证存在）
      dropped.unshift(shifted);
    }
    if (sumOf(kept) <= historyBudget) {
      const result: Message[] = [];
      if (dropped.length > 0) {
        const droppedMessages = flattenGroups(dropped);
        result.push(omissionMessage(droppedMessages.length));
        compressions.push({
          level: 2,
          description: `丢弃最老轮次（${dropped.length} 组 / ${droppedMessages.length} 条消息）`,
          droppedMessages: droppedMessages.length,
          droppedTokens: sumOf(dropped),
        });
      }
      for (const message of flattenGroups(kept)) result.push(message);
      return result;
    }

    // ---- L3：单组仍超预算 → 全部折叠为规则摘要 ----
    const allOld = flattenGroups(oldGroups);
    const summary = foldToSummaryMessage(allOld);
    const summaryTokens = messageTokens(summary, this.count);
    if (summaryTokens <= historyBudget) {
      compressions.push({
        level: 3,
        description: `老对话折叠为规则摘要（${allOld.length} 条 → 1 条）`,
        droppedMessages: allOld.length - 1,
        droppedTokens: sumOf(oldGroups) - summaryTokens,
      });
      return [summary];
    }

    // ---- L4：摘要仍超 → 截断（保底层）----
    const truncatedContent = truncateToTokenBudget(
      summary.content,
      Math.max(1, historyBudget - MESSAGE_OVERHEAD_TOKENS),
      this.count,
    );
    const truncated: UserMessage = { ...summary, content: truncatedContent };
    const truncatedTokens = messageTokens(truncated, this.count);
    compressions.push({
      level: 4,
      description: `规则摘要截断（${summaryTokens} → ${truncatedTokens} tok）`,
      droppedMessages: 0,
      droppedTokens: summaryTokens - truncatedTokens,
    });
    return [truncated];
  }
}

// ===========================================================================
// §3 纯函数辅助
// ===========================================================================

/**
 * 把线性消息序列切成「协议安全的轮次组」。
 * 规则：user / system 消息开启新组；assistant 与 tool 附着当前组——
 * 因此 assistant(tool_calls) 与其全部 tool 结果在分组层面就不可拆分，
 * 后续无论是「丢组」还是「切窗口」都不可能产出非法序列。
 */
function groupMessages(messages: readonly Message[], count: TokenCounter): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let current: Message[] | undefined;

  for (const message of messages) {
    if (message.role === 'user' || message.role === 'system' || current === undefined) {
      if (current !== undefined) {
        groups.push({ messages: current, tokens: messagesTokens(current, count) });
      }
      current = [];
    }
    current.push(message);
  }
  if (current !== undefined) {
    groups.push({ messages: current, tokens: messagesTokens(current, count) });
  }
  return groups;
}

/** 组数组拍平为消息数组（顺序保持） */
function flattenGroups(groups: readonly MessageGroup[]): Message[] {
  const result: Message[] = [];
  for (const group of groups) {
    for (const message of group.messages) result.push(message);
  }
  return result;
}

/**
 * 组装 system 内容：本体 + 注入段落（profile / task）。
 *
 * 为什么注入用 XML 风格标签（<user_profile> / <task_context>）：
 *   大模型对 XML 风格分段的「注意力边界」识别率高（Anthropic 官方
 *   推荐用 XML 标签组织结构化提示词）；纯文本拼接容易让模型把注入
 *   内容误读为 system 本体的一部分（角色混淆）。
 */
function composeSystem(base: string, injections: ContextInjections): string {
  const parts: string[] = [];
  if (base.trim() !== '') parts.push(base);
  const profile = injections.profile?.trim();
  if (profile !== undefined && profile !== '') {
    parts.push(`<user_profile>\n${profile}\n</user_profile>`);
  }
  const task = injections.task?.trim();
  if (task !== undefined && task !== '') {
    parts.push(`<task_context>\n${task}\n</task_context>`);
  }
  return parts.join('\n\n');
}
