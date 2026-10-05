/**
 * ContextManager 与压缩链单元测试。
 * 锚定的决策（对应 manager.ts / compressor.ts 文件头注释）：
 *   - 五层预算分工：system/profile/task 不压缩只警告；history 走压缩链；recent 保底；
 *   - 压缩链逐级升级：L1 工具截断 → L2 丢最老组+占位 → L3 规则摘要 → L4 摘要截断；
 *   - 轮次组协议安全：assistant(tool_calls)+tool 永不拆散，丢弃只发生在组边界；
 *   - 纯函数式：build 不修改传入历史，压缩产物是新对象；
 *   - 注入段落用 XML 标签；事件顺序 context_compressed → context_built。
 *
 * 确定性约定：count = text.length（1 字符 = 1 token），所有预算断言可心算。
 * 每条消息另计 MESSAGE_OVERHEAD_TOKENS = 4（结构开销补偿）。
 */

import { describe, expect, it } from 'vitest';
import { defineConfig } from '../../src/config.ts';
import type { ContextConfig } from '../../src/config.ts';
import { ContextManager } from '../../src/context/manager.ts';
import { messageTokens } from '../../src/context/tokens.ts';
import type { TokenCounter } from '../../src/context/tokens.ts';
import { EventBus } from '../../src/kernel/events.ts';
import type { HarnessEvent } from '../../src/kernel/events.ts';
import { assistantMessage, systemMessage, toolMessage, userMessage } from '../../src/types.ts';
import type { Message, ToolCall } from '../../src/types.ts';

// ---------------------------------------------------------------------------
// 测试装置
// ---------------------------------------------------------------------------

/** 确定性计数：1 字符 = 1 token（与生产同构，便于人工核算预算） */
const count: TokenCounter = (text) => text.length;

const ctx = { sessionId: 's1', queryId: 'q1' } as const;

interface TestContextOptions {
  readonly layers?: Partial<ContextConfig['layers']>;
  readonly toolOutputMaxTokens?: number;
  readonly maxTotalTokens?: number;
}

/**
 * 小预算测试配置：经 defineConfig 构造（附带校验 + 冻结，与生产同路径）。
 * 默认五层和 = 800，远小于 maxTotalTokens（10000）——用例只覆盖关心的层即可。
 */
function makeConfig(options: TestContextOptions = {}): ContextConfig {
  const layers = {
    system: 100,
    profile: 50,
    task: 50,
    history: 200,
    recent: 400,
    ...options.layers,
  };
  return defineConfig({
    context: {
      maxTotalTokens: options.maxTotalTokens ?? 10_000,
      reservedOutputTokens: 100,
      layers,
      toolOutputMaxTokens: options.toolOutputMaxTokens ?? 1_000,
    },
  }).context;
}

function makeManager(options: TestContextOptions = {}, bus?: EventBus): ContextManager {
  return new ContextManager({ config: makeConfig(options), count, bus });
}

/** 索引读取 + undefined 守卫（noUncheckedIndexedAccess 下的测试友好访问） */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`索引 ${index} 不存在（length=${items.length}）`);
  return item;
}

/** 构造带工具调用的 assistant 消息（argsRaw 固定 7 字符，便于心算） */
function assistantWithCall(content: string, callId: string, toolName: string): Message {
  const call: ToolCall = { id: callId, name: toolName, args: { a: 1 }, argsRaw: '{"a":1}' };
  return assistantMessage(content, [call]);
}

// ---------------------------------------------------------------------------
// 预算内直传（无压缩基线）
// ---------------------------------------------------------------------------

describe('预算内组装', () => {
  it('五层都在预算内 → 原样直传，无压缩记录', () => {
    const manager = makeManager();
    const history: Message[] = [systemMessage('系统'), userMessage('你好'), assistantMessage('嗨')];
    const { messages, report } = manager.build(history, ctx);

    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
    expect(report.compressed).toBe(false);
    expect(report.compressions).toEqual([]);
    expect(report.warnings).toEqual([]);
    // 计量：system(2+4) + user(2+4) + assistant(1+4) = 17；分层：system=2，recent=6+5
    expect(report.totalTokens).toBe(17);
    expect(report.layerTokens.system).toBe(2);
    expect(report.layerTokens.recent).toBe(11);
    expect(report.layerTokens.history).toBe(0);
  });

  it('空历史 → 空产物（不产生 system 空消息、不报错）', () => {
    const manager = makeManager();
    const { messages, report } = manager.build([], ctx);
    expect(messages).toEqual([]);
    expect(report.totalTokens).toBe(0);
    expect(report.warnings).toEqual([]);
  });

  it('消息顺序与内容在直传模式下逐字节保持', () => {
    const manager = makeManager();
    const history: Message[] = [
      systemMessage('s'),
      userMessage('第一问'),
      assistantMessage('第一答'),
      userMessage('第二问'),
      assistantMessage('第二答'),
    ];
    const { messages } = manager.build(history, ctx);
    expect(messages).toEqual(history);
  });
});

// ---------------------------------------------------------------------------
// recent / history 划分（尾部窗口 + 连续性）
// ---------------------------------------------------------------------------

describe('recent 划分', () => {
  it('从最新组往前装：装不下的组连同更老组一起进 history（窗口连续）', () => {
    // 三组对话，每组 = user(2+4) + assistant(2+4) = 12 tok
    const manager = makeManager({ layers: { recent: 21, history: 200 } });
    const history: Message[] = [
      systemMessage('s'),
      userMessage('aa'),
      assistantMessage('bb'),
      userMessage('cc'),
      assistantMessage('dd'),
      userMessage('ee'),
      assistantMessage('ff'),
    ];
    const { messages, report } = manager.build(history, ctx);

    // recent=21：G3(12) 装入；G2 需 12+12=24 > 21 → G2 与更老的 G1 全进 history
    expect(report.layerTokens.recent).toBe(12);
    expect(report.layerTokens.history).toBe(24);
    expect(report.compressed).toBe(false); // history 预算 200 足够原样保留
    expect(messages.length).toBe(7);
    expect(at(messages, 5).content).toBe('ee'); // 顺序保持（无断层）
  });
});

// ---------------------------------------------------------------------------
// 压缩链：L2 / L3 / L4
// ---------------------------------------------------------------------------

describe('L2 丢弃最老组 + 占位', () => {
  it('history 超预算 → 从最老组开始丢，插入省略说明，其余原样', () => {
    const manager = makeManager({ layers: { recent: 12, history: 12 } });
    const history: Message[] = [
      userMessage('aa'),
      assistantMessage('bb'),
      userMessage('cc'),
      assistantMessage('dd'),
      userMessage('ee'),
      assistantMessage('ff'),
    ];
    const { messages, report } = manager.build(history, ctx);

    // recent=12 保底 G3；old=[G1,G2] 共 24 > history=12 → 丢 G1（2 条）→ [G2] 12 装下
    expect(messages.map((m) => m.role)).toEqual(['user', 'user', 'assistant', 'user', 'assistant']);
    expect(at(messages, 0).content).toContain('较早的 2 条对话消息');
    expect(at(messages, 0).content).toContain('已被省略');
    expect(report.compressed).toBe(true);
    expect(report.compressions).toEqual([
      expect.objectContaining({ level: 2, droppedMessages: 2, droppedTokens: 12 }),
    ]);
  });
});

describe('L3 规则摘要折叠', () => {
  it('丢到只剩一组仍超预算 → 全部折叠为一条规则摘要', () => {
    // G1/G2 各 608 tok（300 字符 × 2 条 + 结构开销），G3 = 12
    const big = 'u'.repeat(300);
    const bigA = 'a'.repeat(300);
    const manager = makeManager({ layers: { recent: 12, history: 500 } });
    const history: Message[] = [
      userMessage(big),
      assistantMessage(bigA),
      userMessage(big),
      assistantMessage(bigA),
      userMessage('ee'),
      assistantMessage('ff'),
    ];
    const { messages, report } = manager.build(history, ctx);

    // L2 丢 G1 后 [G2] 608 > 500 → L3：4 条折叠为 1 条摘要（片段截断后 ~405 tok ≤ 500）
    expect(messages.length).toBe(3);
    expect(at(messages, 0).role).toBe('user');
    expect(at(messages, 0).content).toContain('较早的 4 条对话消息因上下文预算被压缩为以下摘要');
    expect(at(messages, 0).content).toContain('[用户]'); // 脉略：每条消息一行片段
    expect(at(messages, 0).content).toContain('[AI]');
    expect(report.compressions).toEqual([expect.objectContaining({ level: 3, droppedMessages: 3 })]);
  });
});

describe('L4 摘要截断（保底层）', () => {
  it('摘要仍超预算 → 截断到预算内，保证进程不死', () => {
    const big = 'u'.repeat(300);
    const bigA = 'a'.repeat(300);
    const manager = makeManager({ layers: { recent: 12, history: 100 } });
    const history: Message[] = [
      userMessage(big),
      assistantMessage(bigA),
      userMessage(big),
      assistantMessage(bigA),
      userMessage('ee'),
      assistantMessage('ff'),
    ];
    const { messages, report } = manager.build(history, ctx);

    // L2 丢 G1 → [G2] 608 > 100 → L3 摘要 ~405 > 100 → L4 截断
    expect(messages.length).toBe(3);
    expect(at(messages, 0).content).toContain('已省略');
    expect(messageTokens(at(messages, 0), count)).toBeLessThanOrEqual(100);
    expect(report.compressions).toEqual([expect.objectContaining({ level: 4, droppedMessages: 0 })]);
  });
});

// ---------------------------------------------------------------------------
// L1 工具输出截断
// ---------------------------------------------------------------------------

describe('L1 工具输出压缩', () => {
  it('单条 tool 消息超阈值 → 头尾保留 + 省略标记；原历史不被修改（纯函数性）', () => {
    const manager = makeManager({ toolOutputMaxTokens: 50 });
    const originalTool = toolMessage('c1', 'echo', 'x'.repeat(200));
    const history: Message[] = [userMessage('hi'), assistantWithCall('', 'c1', 'echo'), originalTool];
    const { messages, report } = manager.build(history, ctx);

    const compressedTool = at(messages, 2);
    expect(compressedTool.role).toBe('tool');
    expect(compressedTool.content).toContain('已省略');
    expect(compressedTool.content.length).toBeLessThan(200);
    expect(messageTokens(compressedTool, count)).toBeLessThanOrEqual(50);
    expect(report.compressions).toEqual([expect.objectContaining({ level: 1, droppedMessages: 0 })]);
    // 纯函数性：传入的历史对象必须保持完整（会话存储的原始数据不可被压缩污染）
    expect(originalTool.content.length).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// system 注入（profile / task 层）
// ---------------------------------------------------------------------------

describe('system 注入段落', () => {
  it('profile / task 注入以 XML 标签拼接到 system 消息尾部', () => {
    const manager = makeManager();
    const history: Message[] = [systemMessage('base'), userMessage('hi')];
    const { messages, report } = manager.build(history, ctx, { profile: 'P', task: 'T' });

    expect(at(messages, 0).content).toBe(
      'base\n\n<user_profile>\nP\n</user_profile>\n\n<task_context>\nT\n</task_context>',
    );
    expect(report.layerTokens.profile).toBe(1);
    expect(report.layerTokens.task).toBe(1);
  });

  it('无注入时不出现标签段落', () => {
    const manager = makeManager();
    const { messages } = manager.build([systemMessage('base'), userMessage('hi')], ctx);
    expect(at(messages, 0).content).toBe('base');
  });
});

// ---------------------------------------------------------------------------
// 预算警告（不压缩只警告的层）
// ---------------------------------------------------------------------------

describe('预算警告', () => {
  it('最近一组超 recent 预算 → 保底保留 + 警告（宁可超预算不可零上下文）', () => {
    const manager = makeManager({ layers: { recent: 100, history: 100 } });
    const bigUser = 'x'.repeat(200);
    const history: Message[] = [userMessage(bigUser), assistantMessage('y'.repeat(200))];
    const { messages, report } = manager.build(history, ctx);

    expect(messages.length).toBe(2); // 保底：未截断
    expect(at(messages, 0).content).toBe(bigUser);
    expect(report.warnings.some((w) => w.includes('保底'))).toBe(true);
  });

  it('system 层超预算 → 警告但不截断（改代码而非静默截断）', () => {
    const manager = makeManager({ layers: { system: 5 } });
    const longSystem = 'x'.repeat(20);
    const { messages, report } = manager.build([systemMessage(longSystem), userMessage('hi')], ctx);

    expect(report.warnings.some((w) => w.includes('system 层超预算'))).toBe(true);
    expect(at(messages, 0).content).toBe(longSystem); // 内容完整保留
    expect(report.compressed).toBe(false); // 「警告」与「压缩」是两条通道
  });
});

// ---------------------------------------------------------------------------
// 协议完整性（轮次组不可拆散）
// ---------------------------------------------------------------------------

describe('协议完整性', () => {
  it('丢弃只发生在组边界：不出现孤儿 tool、不拆散 assistant(tool_calls)+tool', () => {
    const manager = makeManager({ layers: { recent: 20, history: 30 } });
    const history: Message[] = [
      userMessage('q1'),
      assistantWithCall('', 'c1', 'echo'),
      toolMessage('c1', 'echo', 'r1'),
      userMessage('q2'),
      assistantWithCall('', 'c2', 'echo'),
      toolMessage('c2', 'echo', 'r2'),
      userMessage('q3'),
      assistantMessage('a3'),
    ];
    const { messages } = manager.build(history, ctx);

    // 配对完整性走查：每个 tool 结果必须能看到发起它的 assistant(tool_calls)
    const pending = new Set<string>();
    const orphans: string[] = [];
    for (const message of messages) {
      if (message.role === 'assistant' && message.toolCalls !== undefined) {
        for (const call of message.toolCalls) pending.add(call.id);
      }
      if (message.role === 'tool') {
        if (!pending.has(message.toolCallId)) orphans.push(message.toolCallId);
        pending.delete(message.toolCallId);
      }
    }
    expect(orphans).toEqual([]); // 无孤儿结果
    expect(pending.size).toBe(0); // 无未配对调用

    // G1（含 c1 调用与结果）整体被丢；G2 / G3 完整保留
    const toolIds = messages.filter((m) => m.role === 'tool').map((m) => m.toolCallId);
    expect(toolIds).toEqual(['c2']);
    expect(at(messages, 0).content).toContain('较早的 3 条对话消息');
  });
});

// ---------------------------------------------------------------------------
// 事件上报
// ---------------------------------------------------------------------------

describe('事件上报', () => {
  it('压缩时先发 context_compressed（每级一条），后发 context_built', () => {
    const bus = new EventBus();
    const events: HarnessEvent[] = [];
    bus.on('*', (event) => events.push(event));

    const manager = makeManager({ layers: { recent: 12, history: 12 } }, bus);
    const history: Message[] = [
      userMessage('aa'),
      assistantMessage('bb'),
      userMessage('cc'),
      assistantMessage('dd'),
      userMessage('ee'),
      assistantMessage('ff'),
    ];
    manager.build(history, ctx);

    expect(events.map((e) => e.type)).toEqual(['context_compressed', 'context_built']);
    const compressed = events[0];
    expect(compressed?.type === 'context_compressed' && compressed.level).toBe(2);
    const built = events[1];
    if (built?.type !== 'context_built') throw new Error('第二个事件应为 context_built');
    expect(built.compressed).toBe(true);
    expect(built.totalTokens).toBeGreaterThan(0);
  });
});
