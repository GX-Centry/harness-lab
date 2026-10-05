/**
 * trigger 单元测试（写入白名单纯函数——逐规则枚举）。
 * 锚定的设计承诺（对应 trigger.ts 文件头）：
 *   - R1 显式记忆请求：中英触发词 + 内容提取（剥离触发短语）；
 *   - kind 判定：内容含偏好标志词 → preference，否则 fact；
 *   - 白名单原则「宁少勿滥」：弱信号不触发（「记得」类回忆陈述、过短内容）；
 *   - v1 不消费 finalText / stopReason（签名保留是为了规则扩展时稳定）。
 */

import { describe, expect, it } from 'vitest';
import { decideMemoryWrites } from '../../src/memory/trigger.ts';

// ---------------------------------------------------------------------------
// 测试装置
// ---------------------------------------------------------------------------

function decide(input: string): ReturnType<typeof decideMemoryWrites> {
  return decideMemoryWrites({ input, finalText: undefined, stopReason: 'completed' });
}

// ---------------------------------------------------------------------------
// R1：显式记忆请求
// ---------------------------------------------------------------------------

describe('R1 显式记忆请求', () => {
  it('「请记住：X」→ 提取正文，命中偏好标志词 → preference', () => {
    const decisions = decide('请记住：我偏好简洁的回答');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      kind: 'preference',
      content: '我偏好简洁的回答',
      rule: 'explicit_request',
    });
  });

  it('「记住X」无分隔符 → 直接剥离触发词', () => {
    const decisions = decide('记住我爱吃辣');
    expect(decisions[0]).toMatchObject({ kind: 'fact', content: '我爱吃辣' });
  });

  it('「别忘了X」→ 触发 + 剥离', () => {
    const decisions = decide('别忘了下周一开会');
    expect(decisions[0]).toMatchObject({ kind: 'fact', content: '下周一开会' });
  });

  it('礼貌前缀「帮我记住」→ 一并剥离', () => {
    const decisions = decide('帮我记住：项目名是 harness-lab');
    expect(decisions[0]).toMatchObject({ kind: 'fact', content: '项目名是 harness-lab' });
  });

  it('英文 remember（大小写不敏感）→ 触发', () => {
    const decisions = decide('Remember: my project is harness-lab');
    expect(decisions[0]).toMatchObject({ kind: 'fact', content: 'my project is harness-lab' });
  });

  it('偏好标志词判定：讨厌 / 风格 / prefer 等都归 preference', () => {
    expect(decide('记住我讨厌冗长输出')[0]?.kind).toBe('preference');
    expect(decide('记住回答用 Markdown 风格')[0]?.kind).toBe('preference');
    expect(decide('记住 I prefer short answers')[0]?.kind).toBe('preference');
  });

  it('无偏好词的事实性内容 → fact', () => {
    expect(decide('记下服务器地址是 10.0.0.1')[0]?.kind).toBe('fact');
  });
});

// ---------------------------------------------------------------------------
// 白名单原则：宁少勿滥
// ---------------------------------------------------------------------------

describe('白名单过滤', () => {
  it('普通输入不触发', () => {
    expect(decide('你好，帮我算一下 2+2')).toEqual([]);
  });

  it('「你还记得…」是回忆陈述不是请求 → 不触发（「记得」不在触发词表）', () => {
    expect(decide('你还记得昨天讨论的方案吗')).toEqual([]);
  });

  it('触发词后无实质内容（「记住！」）→ 不触发', () => {
    expect(decide('记住！')).toEqual([]);
    expect(decide('请记住：')).toEqual([]);
  });

  it('只剥离首个触发短语：内容中的后续文本原样保留', () => {
    const decisions = decide('记住 A，其它都忘掉');
    expect(decisions[0]?.content).toBe('A，其它都忘掉');
  });
});

// ---------------------------------------------------------------------------
// 签名稳定性：v1 不消费 finalText / stopReason
// ---------------------------------------------------------------------------

describe('输入同构性（v1 只依赖 input）', () => {
  it('相同 input 不同结局 → 相同输出（诚实标注「未消费」的证据）', () => {
    const a = decideMemoryWrites({ input: '记住：X', finalText: '回答', stopReason: 'completed' });
    const b = decideMemoryWrites({ input: '记住：X', finalText: undefined, stopReason: 'aborted' });
    expect(a).toEqual(b);
  });
});
