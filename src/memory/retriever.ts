/**
 * retriever —— 记忆检索层：分词 / 打分 / 过滤 / 组装注入（03-module-guide §2.9）。
 *
 * 检索管线（全部纯函数，离线可测——ADR「FakeProvider 打底」的延伸）：
 *
 *   记忆记录集 + 查询文本
 *     │
 *     ├─ ① tokenize：分词（中文 bigram + ASCII 整词）
 *     ├─ ② relevanceOf：查询覆盖率打分（0~1）
 *     ├─ ③ retrieveMemories：阈值过滤 → 稳定排序 → topK 截断
 *     └─ ④ composeInjections：按 kind 组装 profile/task 注入文本
 *
 * 「朴素词频 vs embedding」的设计决策（待决清单第 3 条）：
 *   v1 用词频方案——零依赖、完全确定、离线可测，教学价值在于「检索的本质
 *   是打分排序」而非「用了哪个模型」。升级路径：把 ② 换成向量余弦相似度，
 *   其余管线（③④）不变——接口形状已为此隔离。
 *
 * 中文分词为什么用 bigram（而不是词典/Intl.Segmenter）：
 *   - 词典：需要词表依赖，与「零依赖」冲突；
 *   - Intl.Segmenter：行为依赖安装包的 ICU 数据版本，测试确定性受损；
 *   - bigram：无词典、纯字符串操作，「任意两字相邻即为候选特征」——
 *     检索场景只需「集合重叠度」，切不干净（如「欢你」这种伪词）对
 *     排序的影响是均匀噪声，可接受。
 *
 * 依赖方向：memory/retriever.ts → memory/store.ts（类型）+ context/manager.ts
 *           （ContextInjections 类型——只读依赖，不构造 ContextManager）。
 */

import type { ContextInjections } from '../context/manager.ts';
import type { MemoryRecord } from './store.ts';

// ===========================================================================
// §1 分词
// ===========================================================================

/** CJK 统一表意文字基本区（教学够用；扩展区是演进点） */
function isCjk(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code >= 0x4e00 && code <= 0x9fff;
}

/** ASCII 字母/数字（连续段作为整词） */
function isWordChar(ch: string): boolean {
  return /[a-z0-9]/i.test(ch);
}

/**
 * 分词：中文连续段切 bigram（长度 1 保留单字），英文/数字连续段取整词（小写）。
 * 标点与空白作为分隔符丢弃。
 *
 * 例：「我偏好 ts 9.2」→ { 我偏, 偏好, ts, 9, 2 }
 * （「9.2」被小数点分开为 9 与 2——检索场景可接受，注释留痕。）
 */
export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  let cjkRun: string[] = [];
  let wordRun: string[] = [];

  const flushCjk = (): void => {
    if (cjkRun.length === 1) {
      const single = cjkRun[0];
      if (single !== undefined) tokens.add(single);
    } else {
      for (let i = 0; i + 1 < cjkRun.length; i += 1) {
        const pair = `${cjkRun[i]}${cjkRun[i + 1]}`;
        tokens.add(pair);
      }
    }
    cjkRun = [];
  };
  const flushWord = (): void => {
    if (wordRun.length > 0) tokens.add(wordRun.join(''));
    wordRun = [];
  };

  for (const ch of text.toLowerCase()) {
    if (isCjk(ch)) {
      flushWord();
      cjkRun.push(ch);
    } else if (isWordChar(ch)) {
      flushCjk();
      wordRun.push(ch);
    } else {
      flushCjk();
      flushWord();
    }
  }
  flushCjk();
  flushWord();
  return tokens;
}

// ===========================================================================
// §2 打分
// ===========================================================================

/**
 * 相关度 = 查询覆盖率：查询 token 中能在记录里找到对应的比例（0~1）。
 *
 * 为什么不是 Jaccard（交/并）：一条长记忆与短查询的并集几乎等于记忆自身，
 * 分数被长度稀释——「长记录永远低分」。覆盖率只归一化到查询侧：
 * 「我想找的东西，这条记录覆盖了多少」。
 * 代价：无法区分「覆盖全但没有额外信息」与「覆盖全且高度相关」——
 * 由 retrieveMemories 的同分排序（新者优先）兜底。
 */
export function relevanceOf(
  queryTokens: ReadonlySet<string>,
  recordTokens: ReadonlySet<string>,
): number {
  if (queryTokens.size === 0) return 0;
  let hit = 0;
  for (const token of queryTokens) {
    if (recordTokens.has(token)) hit += 1;
  }
  return hit / queryTokens.size;
}

// ===========================================================================
// §3 检索：过滤 + 排序 + 截断
// ===========================================================================

export interface ScoredMemory {
  readonly record: MemoryRecord;
  readonly score: number;
}

export interface RetrieveOptions {
  /** 返回条数上限（config.memory.retrievalTopK） */
  readonly topK: number;
  /** 相关度阈值（config.memory.minRelevanceScore，0~1） */
  readonly minScore: number;
}

/**
 * 从全部记忆记录中检索与查询最相关的 topK 条。
 * 排序：分数降序；同分保持输入顺序（调用方以「最新优先」喂入 → 同分新者优先）。
 * 过滤先于截断——阈值不达标者绝不进结果（宁可空，不注入噪声）。
 */
export function retrieveMemories(
  records: readonly MemoryRecord[],
  query: string,
  options: RetrieveOptions,
): ScoredMemory[] {
  const queryTokens = tokenize(query);
  const scored: ScoredMemory[] = [];
  for (const record of records) {
    const score = relevanceOf(queryTokens, tokenize(record.content));
    if (score >= options.minScore) {
      scored.push({ record, score });
    }
  }
  // Array.prototype.sort 自 ES2019 起保证稳定：同分保持 records 的原始顺序
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, options.topK);
}

// ===========================================================================
// §4 组装注入
// ===========================================================================

export interface RetrievalResult {
  /** 注入 ContextManager 的 profile/task 文本（无命中 → 空对象） */
  readonly injections: ContextInjections;
  /** 命中条数 */
  readonly count: number;
  /** 最高分（无命中 → 0）；上报 memory_retrieved 事件用 */
  readonly topScore: number;
}

/**
 * 按 kind 组装注入文本：
 *   - preference → profile 层（「用户是谁」——画像信息）
 *   - fact       → task 层（「本次任务要知道什么」——知识信息）
 * 注入的 XML 标签（<user_profile> / <task_context>）由 ContextManager 的
 * composeSystem 负责包裹——本层只产出行文本（职责边界：检索管内容，
 * 组装管格式）。
 */
export function composeInjections(scored: readonly ScoredMemory[]): RetrievalResult {
  const preferenceLines: string[] = [];
  const factLines: string[] = [];
  for (const item of scored) {
    const line = `- ${item.record.content}`;
    if (item.record.kind === 'preference') {
      preferenceLines.push(line);
    } else {
      factLines.push(line);
    }
  }
  const top = scored[0];
  return {
    injections: {
      ...(preferenceLines.length > 0 ? { profile: preferenceLines.join('\n') } : {}),
      ...(factLines.length > 0 ? { task: factLines.join('\n') } : {}),
    },
    count: scored.length,
    topScore: top === undefined ? 0 : top.score,
  };
}
