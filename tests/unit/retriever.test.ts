/**
 * retriever 单元测试（纯函数——无存储、无总线，逐层枚举）。
 * 锚定的设计承诺（对应 retriever.ts 文件头）：
 *   - tokenize：中文 bigram（单字保留）/ ASCII 整词小写 / 标点即分隔；
 *   - relevanceOf：查询覆盖率（不是 Jaccard——不受记录长度稀释）；
 *   - retrieveMemories：阈值过滤 → 分数降序 → 同分新者优先 → topK 截断；
 *   - composeInjections：preference → profile、fact → task。
 */

import { describe, expect, it } from 'vitest';
import {
  composeInjections,
  relevanceOf,
  retrieveMemories,
  tokenize,
} from '../../src/memory/retriever.ts';
import type { MemoryKind, MemoryRecord } from '../../src/memory/store.ts';

// ---------------------------------------------------------------------------
// 测试装置
// ---------------------------------------------------------------------------

function record(content: string, kind: MemoryKind = 'fact', createdAt = 1): MemoryRecord {
  return { id: `m_${content}`, kind, content, sourceSessionId: undefined, createdAt };
}

// ---------------------------------------------------------------------------
// tokenize
// ---------------------------------------------------------------------------

describe('tokenize 分词', () => {
  it('中文连续段切 bigram：4 字 → 3 个相邻对', () => {
    expect(tokenize('我偏好简')).toEqual(new Set(['我偏', '偏好', '好简']));
  });

  it('单字中文段落保留单字（否则「我」类短查询会全丢）', () => {
    expect(tokenize('我')).toEqual(new Set(['我']));
  });

  it('ASCII 连续段取整词并小写：「TypeScript」→ {typescript}', () => {
    expect(tokenize('TypeScript')).toEqual(new Set(['typescript']));
  });

  it('标点与空白即分隔：混合文本按段分别处理', () => {
    expect(tokenize('我偏好 ts-9')).toEqual(new Set(['我偏', '偏好', 'ts', '9']));
  });

  it('空串 → 空集合', () => {
    expect(tokenize('')).toEqual(new Set());
  });
});

// ---------------------------------------------------------------------------
// relevanceOf
// ---------------------------------------------------------------------------

describe('relevanceOf 查询覆盖率', () => {
  it('完全覆盖 → 1；无交集 → 0', () => {
    expect(relevanceOf(new Set(['a', 'b']), new Set(['a', 'b', 'c']))).toBe(1);
    expect(relevanceOf(new Set(['x']), new Set(['a', 'b']))).toBe(0);
  });

  it('部分覆盖 → 精确比例（2/4 = 0.5）', () => {
    expect(relevanceOf(new Set(['a', 'b', 'x', 'y']), new Set(['a', 'b']))).toBe(0.5);
  });

  it('长记录不被长度稀释：覆盖率只看查询侧', () => {
    const query = new Set(['a', 'b']);
    const shortRecord = new Set(['a', 'b', 'c']);
    const longRecord = new Set(['a', 'b', ...Array.from({ length: 50 }, (_, i) => `t${i}`)]);
    expect(relevanceOf(query, shortRecord)).toBe(relevanceOf(query, longRecord));
  });

  it('空查询 → 0（除零护栏）', () => {
    expect(relevanceOf(new Set(), new Set(['a']))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// retrieveMemories
// ---------------------------------------------------------------------------

describe('retrieveMemories 检索', () => {
  it('阈值过滤 + 分数降序（同分保持输入顺序）', () => {
    const records = [
      record('我偏好简洁的回答', 'preference'), // 交集 3/8 = 0.375
      record('我偏好中间长度的回答', 'preference'), // 交集同 3 个 token → 与上同分
      record('今天天气不错'), // 无重叠 → 被阈值滤掉
      record('我偏好什么回答', 'preference'), // 交集 6/8 = 0.75（最高分）
    ];
    const query = '我偏好什么回答风格？';
    const result = retrieveMemories(records, query, { topK: 5, minScore: 0.3 });

    // 分数降序：0.75 在前；A/B 同分 → 保持输入顺序；无重叠记录被滤掉
    expect(result.map((r) => r.record.content)).toEqual([
      '我偏好什么回答',
      '我偏好简洁的回答',
      '我偏好中间长度的回答',
    ]);
  });

  it('topK 截断生效：命中多条时只取前 K', () => {
    const records = [
      record('我偏好简洁的回答', 'preference'),
      record('我偏好详细的回答', 'preference'),
      record('用户偏好中文回答', 'preference'),
    ];
    const result = retrieveMemories(records, '我偏好什么回答？', { topK: 2, minScore: 0.3 });
    expect(result).toHaveLength(2);
  });

  it('全部低于阈值 → 空数组（宁可空不注入噪声）', () => {
    const records = [record('今天天气不错')];
    expect(retrieveMemories(records, '完全无关的查询', { topK: 3, minScore: 0.5 })).toEqual([]);
  });

  it('同分保持输入顺序（调用方以最新优先喂入 → 同分新者优先）', () => {
    // 两条记录与查询的覆盖率相同（都命中「回答」一个 token）
    const newer = record('回答 X', 'fact', 200);
    const older = record('回答 Y', 'fact', 100);
    const result = retrieveMemories([newer, older], '回答 Z', { topK: 2, minScore: 0.3 });
    expect(result.map((r) => r.record.createdAt)).toEqual([200, 100]);
  });
});

// ---------------------------------------------------------------------------
// composeInjections
// ---------------------------------------------------------------------------

describe('composeInjections 组装', () => {
  it('preference → profile 行文本；fact → task 行文本；行格式「- 内容」', () => {
    const result = composeInjections([
      { record: record('我偏好简洁的回答', 'preference'), score: 0.8 },
      { record: record('项目名是 harness-lab', 'fact'), score: 0.6 },
    ]);
    expect(result.injections.profile).toBe('- 我偏好简洁的回答');
    expect(result.injections.task).toBe('- 项目名是 harness-lab');
    expect(result.count).toBe(2);
    expect(result.topScore).toBe(0.8);
  });

  it('同类多条合并为多行（保持检索顺序）', () => {
    const result = composeInjections([
      { record: record('偏好 A', 'preference'), score: 0.9 },
      { record: record('偏好 B', 'preference'), score: 0.5 },
    ]);
    expect(result.injections.profile).toBe('- 偏好 A\n- 偏好 B');
    expect(result.injections.task).toBeUndefined();
  });

  it('空命中 → 空注入 + count 0 + topScore 0', () => {
    const result = composeInjections([]);
    expect(result.injections).toEqual({});
    expect(result.count).toBe(0);
    expect(result.topScore).toBe(0);
  });
});
