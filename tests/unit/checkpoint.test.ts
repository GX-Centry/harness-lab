/**
 * 检查点工具（恢复语义纯函数）单元测试。
 * 锚定的决策（对应 checkpoint.ts 文件头）：
 *   - pending 从消息推导（单一事实来源）——扫描配对，宣布未核销者即 pending；
 *   - 补位而非重放（「崩溃」当作「取消」处理）；
 *   - 幂等：补过占位的快照再推导必得空集（repeated resume 的安全根基）；
 *   - 纯函数：输入数组永不被修改。
 */

import { describe, expect, it } from 'vitest';
import {
  INTERRUPTED_TOOL_REASON,
  fillInterruptedToolResults,
  pendingToolCallsOf,
} from '../../src/session/checkpoint.ts';
import { assistantMessage, toolMessage, userMessage } from '../../src/types.ts';
import type { Message, ToolCall } from '../../src/types.ts';

// ---------------------------------------------------------------------------
// 测试装置
// ---------------------------------------------------------------------------

function call(id: string, name: string): ToolCall {
  return { id, name, args: {}, argsRaw: '{}' };
}

function assistantWithCalls(calls: readonly ToolCall[]): Message {
  return assistantMessage('', calls);
}

// ---------------------------------------------------------------------------
// pendingToolCallsOf：推导
// ---------------------------------------------------------------------------

describe('pendingToolCallsOf', () => {
  it('空历史 → 无 pending', () => {
    expect(pendingToolCallsOf([])).toEqual([]);
  });

  it('全部配对 → 无 pending（每轮一致点的正常状态）', () => {
    const messages: Message[] = [
      userMessage('问题'),
      assistantWithCalls([call('c1', 'echo'), call('c2', 'calculator')]),
      toolMessage('c1', 'echo', 'r1'),
      toolMessage('c2', 'calculator', 'r2'),
      assistantMessage('回答'),
    ];
    expect(pendingToolCallsOf(messages)).toEqual([]);
  });

  it('宣布两个、核销一个 → 返回缺失的那个（含 name）', () => {
    const messages: Message[] = [
      assistantWithCalls([call('c1', 'echo'), call('c2', 'calculator')]),
      toolMessage('c1', 'echo', 'r1'),
    ];
    expect(pendingToolCallsOf(messages)).toEqual([{ id: 'c2', name: 'calculator' }]);
  });

  it('跨多条 assistant 消息的未完成调用按宣布顺序返回', () => {
    const messages: Message[] = [
      assistantWithCalls([call('a1', 'echo')]),
      toolMessage('a1', 'echo', 'ok'),
      assistantWithCalls([call('b1', 'echo'), call('b2', 'calculator')]),
      toolMessage('b1', 'echo', 'ok'),
    ];
    expect(pendingToolCallsOf(messages)).toEqual([{ id: 'b2', name: 'calculator' }]);
  });

  it('最后一条是 assistant(tool_calls) 且无任何结果 → 全部 pending', () => {
    const messages: Message[] = [
      userMessage('问题'),
      assistantWithCalls([call('c1', 'echo'), call('c2', 'echo')]),
    ];
    expect(pendingToolCallsOf(messages)).toEqual([
      { id: 'c1', name: 'echo' },
      { id: 'c2', name: 'echo' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// fillInterruptedToolResults：补位
// ---------------------------------------------------------------------------

describe('fillInterruptedToolResults', () => {
  it('为缺失调用补 tool 占位消息（默认文案、配对 id 与 name 正确）', () => {
    const messages: Message[] = [assistantWithCalls([call('c1', 'echo')])];
    const { messages: filled, filled: filledCalls } = fillInterruptedToolResults(messages);

    expect(filledCalls).toEqual([{ id: 'c1', name: 'echo' }]);
    expect(filled.length).toBe(2);
    const placeholder = filled[1];
    expect(placeholder?.role).toBe('tool');
    if (placeholder?.role !== 'tool') throw new Error('占位消息应为 tool 角色');
    expect(placeholder.toolCallId).toBe('c1');
    expect(placeholder.name).toBe('echo');
    expect(placeholder.content).toBe(INTERRUPTED_TOOL_REASON);
  });

  it('纯函数：输入数组不被修改', () => {
    const messages: Message[] = [assistantWithCalls([call('c1', 'echo')])];
    const before = messages.length;
    fillInterruptedToolResults(messages);
    expect(messages.length).toBe(before);
  });

  it('无 pending → 返回拷贝（新数组）且 filled 为空', () => {
    const messages: Message[] = [userMessage('hi')];
    const { messages: filled, filled: filledCalls } = fillInterruptedToolResults(messages);
    expect(filledCalls).toEqual([]);
    expect(filled).toEqual(messages);
    expect(filled).not.toBe(messages); // 新数组
  });

  it('幂等：补过位的消息再次调用 → 无需修复', () => {
    const messages: Message[] = [assistantWithCalls([call('c1', 'echo')])];
    const first = fillInterruptedToolResults(messages);
    expect(first.filled.length).toBe(1);

    const second = fillInterruptedToolResults(first.messages);
    expect(second.filled).toEqual([]); // 不重复补
    expect(second.messages.length).toBe(first.messages.length);
  });

  it('reason 可定制（测试/本地化注入）', () => {
    const messages: Message[] = [assistantWithCalls([call('c1', 'echo')])];
    const { messages: filled } = fillInterruptedToolResults(messages, '自定义中断说明');
    const placeholder = filled[1];
    expect(placeholder?.content).toBe('自定义中断说明');
  });
});
