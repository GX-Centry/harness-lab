/**
 * 配置中心 —— 全系统的「显式默认值」。
 *
 * 设计原则：
 *
 * 1. 「显式默认值」：每个数值/开关都写在这里，且注释说明「调大/调小的代价」。
 *    禁止在业务模块里散落魔法数字——它们是隐藏的配置，改起来无从下手。
 *
 * 2. 「不可变」：defineConfig() 返回的对象被深冻结（deepFreeze）。
 *    配置是跨模块共享的「事实」：运行期被某处意外篡改会产生不可复现的 bug。
 *    冻结让误写当场抛 TypeError（严格模式），把问题消灭在第一现场。
 *    需要不同配置 = 调用 defineConfig 得到新对象（测试的隔离性来源）。
 *
 * 3. 「启动期校验」：defineConfig 内部校验配置自洽性（如预算分层合计），
 *    不合法的配置直接抛 config_error——错误在启动期暴露，而不是运行到一半。
 *
 * 配置优先级链的演进规划（当前只实现前两层）：
 *   CLI 参数 > 环境变量(HARNESS_*) > defineConfig(overrides) > defaultConfig
 *   ——w17 做 CLI 时补第三层；环境变量层在真实 Provider 接入（w05+）时按需加。
 *
 * 依赖方向：config.ts → types.ts（取 RiskLevel 等）→ errors.ts。
 */

import { HarnessError } from './errors.ts';
import type { PermissionDecision, RiskLevel } from './types.ts';

// ===========================================================================
// §1 配置形状（分域接口）
// ===========================================================================

/** Agent Loop 域 */
export interface LoopConfig {
  /**
   * 单个 query 的最大轮次（一轮 = 一次模型调用 + 其触发的全部工具执行）。
   * 代价：调大 → 更复杂的任务可能完成，但失控模型的成本上限随之升高；
   *       调小 → 省钱但复杂任务中途被截断。
   * 16 的取值理由：覆盖「检索-计算-写作」类多步任务，且远小于失控阈值。
   */
  readonly maxTurns: number;
}

/** 重试策略（指数退避） */
export interface RetryConfig {
  /** 最大尝试次数（含首次）。3 = 首次 + 最多 2 次重试 */
  readonly maxAttempts: number;
  /** 退避基数：第 n 次重试等待 baseDelayMs * 2^(n-1)（+ 抖动） */
  readonly baseDelayMs: number;
  /** 退避上限：防止指数增长到不可用 */
  readonly maxDelayMs: number;
}

/** LLM 域 */
export interface LlmConfig {
  /** 默认模型标识。FakeProvider 忽略此值；真实 Provider 用它做默认路由（w05+） */
  readonly defaultModel: string;
  /** 单次模型调用超时（含流式全过程）。超时归类 timeout_error（可重试） */
  readonly requestTimeoutMs: number;
  readonly retry: RetryConfig;
}

/**
 * 上下文分层预算（ADR-007 的落地）。
 * 为什么是 5 层而不是一个总数？
 *   不同信息的「价值密度」不同：system 是行为准则（几乎不能丢），
 *   recent 是本轮刚发生的事（精度最重要），history 是较早对话（可压缩成摘要）。
 *   分层让压缩策略可以「按层降级」而不是「一刀切截断」。
 */
export interface ContextLayerBudgets {
  /** 系统提示词：行为准则 + 工具说明，基本固定，超了应该改代码而不是截断 */
  readonly system: number;
  /** 用户画像：跨会话偏好（memory 层提供） */
  readonly profile: number;
  /** 任务层：本次任务指令 + 记忆检索结果注入处 */
  readonly task: number;
  /** 历史层：较早轮次的压缩摘要区（压缩后的事都住这里） */
  readonly history: number;
  /** 近期层：最近 N 轮原文，保精度 */
  readonly recent: number;
}

/** 上下文域 */
export interface ContextConfig {
  /**
   * 上下文总预算（tokens）。ADR-007：不喂满模型窗口（128k+），
   * 16k 精打细算通常优于 100k 稀释——成本与注意力双重理由。
   * 代价：复杂长任务可能需要调大（改这一个数即可，推翻成本极低）。
   */
  readonly maxTotalTokens: number;
  /**
   * 为「模型输出」预留的 token（不参与输入组装）。
   * 预留不足 → 模型输出到一半被 max_tokens 截断（stopReason 可见）。
   */
  readonly reservedOutputTokens: number;
  /** 五层预算分配（合计应 <= maxTotalTokens，启动期校验） */
  readonly layers: ContextLayerBudgets;
  /**
   * 单条工具结果进入「近期层」前的压缩阈值（tokens）。
   * 超限的工具输出先在此处降级：保留头部 + 尾部 + 「已省略 N 行」标记。
   * 理由：工具输出（如日志、文件内容）是上下文爆炸的第一大来源。
   */
  readonly toolOutputMaxTokens: number;
}

/** 权限域 */
export interface PermissionConfig {
  /**
   * 按风险级的默认策略（规则层未命中时的兜底决策）。
   * 权衡：critical 默认 confirm 而非 deny——deny 会让高危工具完全不可用，
   *       教学项目保留可用性；生产环境可按需改为 deny（改这一张表）。
   */
  readonly policyByRisk: Readonly<Record<RiskLevel, PermissionDecision>>;
  /**
   * confirm 交互的超时（毫秒）。超时默认「拒绝」：
   * 无人应答时放行是最危险的失败方向（fail-safe 原则）。
   */
  readonly confirmTimeoutMs: number;
}

/** 检查点策略（待决清单第 1 条的初版落地） */
export interface CheckpointConfig {
  /**
   * 保存时机：
   *   every_turn  每轮结束（安全，多写一次 DB）
   *   after_tool  每次工具执行后（最细，写放大）
   *   manual      仅显式调用时（快，崩溃丢失窗口大）
   * 默认 every_turn：教学项目优先「恢复语义直观」；性能实测后可改。
   */
  readonly mode: 'every_turn' | 'after_tool' | 'manual';
  /** 每个会话保留的检查点数（滚动删除更早的） */
  readonly keepLast: number;
}

/** 会话域 */
export interface SessionConfig {
  /**
   * SQLite 存储路径（相对仓库根目录）。
   * w10 实现时解析为绝对路径——绝不依赖进程 cwd（否则「在哪个目录启动」会改变数据位置）。
   */
  readonly storePath: string;
  readonly checkpoint: CheckpointConfig;
}

/** 记忆域 */
export interface MemoryConfig {
  /** 总开关：关闭后 memory 模块完全不介入（检索/写入都短路） */
  readonly enabled: boolean;
  /** 检索返回条数上限 */
  readonly retrievalTopK: number;
  /**
   * 检索相关度阈值（词频相似度，0~1）。
   * 代价：调低 → 召回多但可能注入噪声；调高 → 精准但可能漏掉有用的记忆。
   */
  readonly minRelevanceScore: number;
}

/** 工具执行域 */
export interface ToolsConfig {
  /**
   * 单工具执行的默认超时（毫秒）。Dispatcher 用 Promise.race 兜底。
   * 注意语义：超时是「保护」不是「取消」——被超时的工具若无视 signal.aborted
   * 仍会在后台跑完（僵尸 promise）。工具尊重 ctx.signal 才是真正的协作式取消。
   */
  readonly defaultTimeoutMs: number;
}

/**
 * 子代理域（w13）。
 * 三个字段全部服务于同一个设计：子代理是「窄而深」的窄任务——
 * 预算比主循环小、超时必须自闭环、并发要显式设限。
 */
export interface SubagentConfig {
  /**
   * 并发池的默认并发度（fan-out 同时运行的子代理数上限）。
   * 代价：调大 → 吞吐高、墙钟时间短，但对 Provider 的瞬时并发压力
   * 与限流风险同步上升（每个子代理 = 一条独立的模型调用流）；
   * 调小 → 保守稳定，但批量任务退化为串行。
   * 3 的取值理由：教学场景下「并发效果肉眼可见」且远低于常见 RPM 限制。
   */
  readonly maxConcurrency: number;
  /**
   * 单个子代理任务的默认超时（毫秒），可被 SubAgentDefinition.timeoutMs 覆盖。
   * 语义提醒：与 config.tools.defaultTimeoutMs 的「Promise.race 保护」不同，
   * 这是**协作式取消**——到时真正 abort 子循环（子循环在轮次边界与流分片
   * 处都会检查 signal），而不是丢下僵尸 promise。
   */
  readonly taskTimeoutMs: number;
  /**
   * 子代理循环的默认 maxTurns，可被 SubAgentDefinition.maxTurns 覆盖。
   * 通常小于主循环（8 < 16）：子任务是窄任务，轮次预算过大意味着
   * 「子代理失控」的成本上限与主代理同级——与「窄而深」的定位相悖。
   */
  readonly maxTurns: number;
}

/** Hook 域 */
export interface HooksConfig {
  /**
   * 重复调用熔断阈值：同一工具 + 相同参数连续出现 N 次 → block（ADR-005 的兜底）。
   * 取值 3：模型偶尔重试 2 次是正常的自我修正，第 3 次开始大概率是死循环。
   */
  readonly repeatCallThreshold: number;
}

/** 可观测域（w14） */
export interface ObservabilityConfig {
  /** 是否收集事件追踪（Tracer 订阅 EventBus 通配 '*'） */
  readonly trace: boolean;
  /**
   * 环形缓冲容量：Tracer 最多留存的事件数，超出后丢弃最老。
   * 代价：调大 → 内存增高（长驻进程要盯紧）；调小 → 诊断时历史被截断。
   * 注意：容量只影响「留存」，不影响「采集」——收到总数与丢弃数都可查。
   */
  readonly traceCapacity: number;
  /**
   * 是否累计 token 成本（CostTracker 订阅 llm_response、产出 usage_recorded）。
   * 注意订阅链是单向的：llm_response →（查定价表计价）→ usage_recorded——
   * 「已定价」的定价权在成本域（w04 草案曾写「订阅 usage_recorded」，已修正，
   * 理由见 src/observability/types.ts 必答问题 ③）。
   */
  readonly costTracking: boolean;
}

/** 全量配置：所有域的组合（defineConfig 的输入形状） */
export interface HarnessConfig {
  readonly loop: LoopConfig;
  readonly llm: LlmConfig;
  readonly tools: ToolsConfig;
  readonly context: ContextConfig;
  readonly permission: PermissionConfig;
  readonly session: SessionConfig;
  readonly memory: MemoryConfig;
  readonly hooks: HooksConfig;
  readonly subagent: SubagentConfig;
  readonly observability: ObservabilityConfig;
}

// ===========================================================================
// §2 默认值（唯一的"魔法数字"集中地）
// ===========================================================================

/**
 * 默认配置。修改任何数值前先读对应接口字段的注释——那里写明了代价。
 * 预算算式：16000 = system 2000 + profile 1000 + task 3000 + history 4000 + recent 6000
 */
export const defaultConfig: HarnessConfig = {
  loop: {
    maxTurns: 16,
  },
  llm: {
    defaultModel: 'fake/model-1',
    requestTimeoutMs: 60_000,
    retry: {
      maxAttempts: 3,
      baseDelayMs: 500,
      maxDelayMs: 8_000,
    },
  },
  context: {
    maxTotalTokens: 16_000,
    reservedOutputTokens: 4_000,
    layers: {
      system: 2_000,
      profile: 1_000,
      task: 3_000,
      history: 4_000,
      recent: 6_000,
    },
    toolOutputMaxTokens: 1_000,
  },
  tools: {
    defaultTimeoutMs: 30_000,
  },
  permission: {
    policyByRisk: {
      low: 'allow',
      medium: 'confirm',
      high: 'confirm',
      critical: 'confirm',
    },
    confirmTimeoutMs: 30_000,
  },
  session: {
    storePath: 'data/harness.db',
    checkpoint: {
      mode: 'every_turn',
      keepLast: 3,
    },
  },
  memory: {
    enabled: true,
    retrievalTopK: 3,
    minRelevanceScore: 0.3,
  },
  hooks: {
    repeatCallThreshold: 3,
  },
  subagent: {
    maxConcurrency: 3,
    taskTimeoutMs: 60_000,
    maxTurns: 8,
  },
  observability: {
    trace: true,
    traceCapacity: 1_000,
    costTracking: true,
  },
};

// ===========================================================================
// §3 深合并 / 深冻结 / 校验（教学实现，零依赖）
// ===========================================================================

/** 递归可选：overrides 里只写想改的字段，其余保持默认 */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

type PlainObject = Record<string, unknown>;

/** 判定「普通对象」（排除 null / 数组：它们的合并语义不同，配置里也用不到） */
function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 手写深合并（教学点：不引 lodash.merge——40 行就能看清「深合并」的全部语义）。
 * 规则：
 *   - override 中 undefined 的键视为「未提供」，保留 base 值（支持可选字段）；
 *   - 两侧都是普通对象 → 递归合并；
 *   - 其余情况（基本类型 / 类型不匹配）→ override 直接覆盖。
 */
function deepMerge(base: PlainObject, override: PlainObject): PlainObject {
  const result: PlainObject = { ...base };
  for (const [key, overrideValue] of Object.entries(override)) {
    if (overrideValue === undefined) continue;
    const baseValue = result[key];
    if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
      result[key] = deepMerge(baseValue, overrideValue);
    } else {
      result[key] = overrideValue;
    }
  }
  return result;
}

/**
 * 深冻结：递归 Object.freeze 到每个嵌套对象。
 * 为什么值得：配置对象会被注入到几乎所有模块；某处意外赋值
 * （如 `config.loop.maxTurns = 99`）在冻结后立即抛 TypeError，
 * 而不是制造「运行到某个时刻才暴露」的幽灵 bug。
 */
function deepFreeze<T>(value: T): T {
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      deepFreeze(value[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * 启动期自洽性校验：不合法的配置**立即**抛 config_error。
 * 目前覆盖两条最容易写错的约束；将来约束变多时，这里会拆成独立模块。
 */
function validateConfig(config: HarnessConfig): void {
  const { maxTotalTokens, reservedOutputTokens, layers } = config.context;
  const layerSum = layers.system + layers.profile + layers.task + layers.history + layers.recent;
  if (layerSum > maxTotalTokens) {
    throw new HarnessError(
      'config_error',
      `上下文分层预算合计 ${layerSum} 超过总量 ${maxTotalTokens}（检查 context.layers）`,
      { where: 'config' },
    );
  }
  if (config.loop.maxTurns <= 0) {
    throw new HarnessError('config_error', `loop.maxTurns 必须为正数，当前 ${config.loop.maxTurns}`, {
      where: 'config',
    });
  }
  // w13：子代理域的防呆——三个非正数都会导致运行期出现「零并发死锁 /
  // 立即超时 / 一步都不允许走」这类难以归因的怪象，启动期直接拒绝。
  const { maxConcurrency, taskTimeoutMs, maxTurns } = config.subagent;
  if (maxConcurrency <= 0 || taskTimeoutMs <= 0 || maxTurns <= 0) {
    throw new HarnessError(
      'config_error',
      `subagent 配置必须全为正数：maxConcurrency=${maxConcurrency}, taskTimeoutMs=${taskTimeoutMs}, maxTurns=${maxTurns}`,
      { where: 'config' },
    );
  }
  if (reservedOutputTokens >= config.llm.requestTimeoutMs) {
    // 防呆：这两个单位不同（token vs 毫秒），只是提示写配置时别把数字串错域
    throw new HarnessError(
      'config_error',
      `疑似串域配置：reservedOutputTokens(${reservedOutputTokens}) 不应 >= requestTimeoutMs(${config.llm.requestTimeoutMs})`,
      { where: 'config' },
    );
  }
  // w14：可观测域防呆——零/负容量会让 Tracer 构造期抛错（其实也是同一道
  // 防线），但启动期拒绝更早、报错更集中（配置问题的定位成本最低处就在这）。
  if (config.observability.traceCapacity <= 0) {
    throw new HarnessError(
      'config_error',
      `observability.traceCapacity 必须为正数，当前 ${config.observability.traceCapacity}`,
      { where: 'config' },
    );
  }
}

// ===========================================================================
// §4 对外唯一入口
// ===========================================================================

/**
 * 组装（并冻结）一份完整配置。全项目所有配置获取都必须经过这里。
 *
 * @example
 *   const config = defineConfig();                                 // 全默认
 *   const config = defineConfig({ loop: { maxTurns: 32 } });       // 只改轮次
 *
 * 测试友好性：不同测试可以拿到彼此隔离的配置对象，且不可能互相污染。
 */
export function defineConfig(overrides: DeepPartial<HarnessConfig> = {}): HarnessConfig {
  const merged = deepMerge(
    defaultConfig as unknown as PlainObject,
    overrides as unknown as PlainObject,
  ) as unknown as HarnessConfig;
  validateConfig(merged);
  return deepFreeze(merged);
}
