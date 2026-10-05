/**
 * Orchestrator —— fan-out 编排与「模型驱动的 spawn 工具」。
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 两种驱动形态（同一条 runSubagents 内核）                              │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 *   形态 1：编程式（runSubagents）
 *     调用方是代码（CLI 批处理命令 / 未来 pipeline / Eval 场景）：
 *     runSubagents({ tasks: [...], definitions, deps }) → 结构化报告。
 *
 *   形态 2：模型驱动（createOrchestratorTool）
 *     「spawn_subagents」作为一个普通工具注册进父 registry——父模型
 *     自主决定「把任务拆成哪几个子任务、分派给谁、并发跑」。工具的
 *     ToolResult 是报告的文本化（模型看到 ✓/✗ 清单与摘要）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 编排模式谱系（本项目实现 fan-out；其余为讲解性保留——为什么不做）：
 *
 *   fan-out（w13 已实现）：N 个独立任务并发跑，各自结算、汇总报告。
 *     适用：批量独立子任务（「分别调研 A/B/C 三个主题」）。
 *   race（未实现）：多路方案竞速，第一个成功者胜出，其余取消。
 *     为什么不做：v1 无真实网络抖动场景，胜出语义无法确定性测试；
 *     且「取消落败者」依赖池的协作式取消——机制已就绪（pool 的
 *     AbortError 传播），未来加一个 20 行的 race 循环即可。
 *   pipeline（未实现）：任务链式（A 的输出是 B 的输入）。
 *     为什么不做：链式编排 = 确定性数据依赖，用 w12 的 Skill 更合适
 *     （Skill 就是「固定顺序 + 数据传递」的成熟实现）；把 pipeline
 *     塞进子代理层是能力重叠，违反「一个能力一个家」的分层纪律。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 错误哲学（三层防线，与全项目一致）：
 *   1. **装配期**：坏定义（重名/引用未注册工具）→ 立即抛 config_error
 *      （compileAgentTools 在 fan-out 开始前完成全部编译——错误在第一现场）；
 *   2. **任务期**：运行失败（超时/轮次耗尽/内部异常）→ 结构化结算为
 *      TaskOutcome.ok=false（partial 语义：不株连其他任务）；
 *   3. **控制期**：AbortError → 穿透池与工具边界，由父 Loop 收敛
 *      （取消永远不是「一个任务的结果」——见 pool.ts 的分类学）。
 *
 * 依赖方向：subagent/orchestrator.ts → subagent/agent-tool + pool + types
 *           + errors / types（全局）。
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isAbortError, toHarnessError } from '../errors.ts';
import type { Tool, ToolContext, ToolResult, Usage } from '../types.ts';
import { okResult } from '../types.ts';
import { compileAgentTools } from './agent-tool.ts';
import { runWithConcurrency } from './pool.ts';
import type {
  SubAgentDefinition,
  SubAgentDeps,
  SubagentRunReport,
  SubagentTaskSpec,
  TaskFailureReason,
  TaskOutcome,
} from './types.ts';

// ===========================================================================
// §1 runSubagents —— 编程式 fan-out
// ===========================================================================

/** 审计关联信息（转交每个子任务的 ToolContext；缺省值见 DEFAULTS 注释） */
export interface OrchestratorContext {
  readonly sessionId: string;
  readonly queryId: string;
  readonly workingDir: string;
}

export interface RunSubagentsOptions {
  /** 子代理装配依赖（与 createAgentTool 同款） */
  readonly deps: SubAgentDeps;
  /** 本次可用的子代理目录（编译期校验重名/引用——错误早暴露） */
  readonly definitions: readonly SubAgentDefinition[];
  /** 要分派的任务列表（输出报告与输入同序） */
  readonly tasks: readonly SubagentTaskSpec[];
  /** 并发度覆盖（缺省 config.subagent.maxConcurrency） */
  readonly concurrency?: number;
  /** 取消信号（编程调用方可传；spawn 工具路径传父 ctx.signal） */
  readonly signal?: AbortSignal;
  /** 审计关联（缺省用中性默认值——编程调用可能不处在会话上下文里） */
  readonly context?: Partial<OrchestratorContext>;
}

/** 永不触发取消的信号（缺省 signal 的替身——避免调用方到处判 undefined） */
const NEVER_ABORT = new AbortController().signal;

/** TaskFailureReason 的运行时校验表（meta 是 Record<string, unknown>，需收窄） */
const FAILURE_REASONS: readonly string[] = [
  'unknown_agent',
  'input_error',
  'unknown_tool',
  'timeout',
  'max_turns',
  'run_error',
];

/**
 * fan-out 主入口：把任务列表交给并发池执行，返回结构化报告。
 *
 * 与 AgentTool 的关系：每个任务直接驱动「编译好的 AgentTool 实例」
 * （tool.execute）——不经过父 Dispatcher。为什么可以？（对照 w12 SkillRunner
 * 走 Dispatcher 的选择，这里给出边界条件：）
 *   - SkillRunner 面对的是「模型给的参数」，输入校验是安全责任 → 必须走
 *     Dispatcher 的四步链；
 *   - orchestrator 的调用方是**代码**（或 spawn 工具——它自己就是走完
 *     Dispatcher 的工具），任务文本由调用方构造，无「模型幻觉参数」风险；
 *   - 横切策略（权限/hook）对子代理的作用点在**子世界内部**（childDispatcher
 *     逐工具四步链）——外层再包一层 Dispatcher 只会产生重复审计事件。
 *   本函数仍自行做 zod 校验（inputSchema.safeParse）——防御性收口。
 */
export async function runSubagents(options: RunSubagentsOptions): Promise<SubagentRunReport> {
  const { deps, tasks } = options;

  // ---- 装配期：编译全部定义（重名 / 引用未知工具在此抛 config_error）----
  const { catalog, tools } = compileAgentTools(options.definitions, deps);

  const audit: OrchestratorContext = {
    sessionId: options.context?.sessionId ?? 'orchestrator',
    queryId: options.context?.queryId ?? `spawn_${randomUUID()}`,
    workingDir: options.context?.workingDir ?? process.cwd(),
  };
  const signal = options.signal ?? NEVER_ABORT;

  // ---- 任务期：每个 spec 一个闭包（错误尽量在「结算」而不在「抛出」）----
  const taskFns = tasks.map((spec) => async (): Promise<TaskOutcome> => {
    const definition = catalog.get(spec.agent);
    if (definition === undefined) {
      // 引用解析失败是「任务数据」问题（可能来自用户输入的批量清单）——
      // 结构化结算，不抛错（对照：定义编译失败是装配问题，上面已抛）。
      return {
        ok: false,
        agent: spec.agent,
        task: spec.task,
        errorCode: 'input_error',
        reason: 'unknown_agent',
        message: `未知子代理 "${spec.agent}"。可用：${[...catalog.keys()].join(', ') || '（无）'}`,
      };
    }

    const tool = tools.get(spec.agent);
    if (tool === undefined) {
      // 编译保障 catalog 与 tools 同键——此分支不可达（防御性）
      return {
        ok: false,
        agent: spec.agent,
        task: spec.task,
        errorCode: 'internal_error',
        reason: 'run_error',
        message: `子代理 "${spec.agent}" 编译产物缺失（契约破坏）`,
      };
    }

    // 校验收口：绕过 Dispatcher 的调用路径由本层补回校验（见函数头注释）
    const parsed = tool.inputSchema.safeParse({ task: spec.task });
    if (!parsed.success) {
      return {
        ok: false,
        agent: spec.agent,
        task: spec.task,
        errorCode: 'input_error',
        reason: 'input_error',
        message: `任务描述不合法（不能为空）：${parsed.error.issues.map((i) => i.message).join('; ')}`,
      };
    }

    const toolCtx: ToolContext = {
      sessionId: audit.sessionId,
      queryId: audit.queryId,
      workingDir: audit.workingDir,
      signal,
    };

    try {
      const result = await tool.execute(parsed.data, toolCtx);
      return toTaskOutcome(spec, result);
    } catch (raw) {
      // 取消穿透池（控制流）；其余异常在此结算（本层不再有多余的防线）
      if (isAbortError(raw)) throw raw;
      const error = toHarnessError(raw, 'subagent/orchestrator');
      return {
        ok: false,
        agent: spec.agent,
        task: spec.task,
        errorCode: 'internal_error',
        reason: 'run_error',
        message: error.message,
      };
    }
  });

  // ---- 控制期：并发池（AbortError 会从这里向上抛——见 pool.ts）----
  const poolOutcomes = await runWithConcurrency(taskFns, {
    concurrency: options.concurrency ?? deps.config.subagent.maxConcurrency,
  });

  // ---- 聚合：pool 的泛型 outcome → 域内报告 ----
  const outcomes: TaskOutcome[] = [];
  let okCount = 0;
  let failCount = 0;
  const totalUsage: { inputTokens: number; outputTokens: number } = {
    inputTokens: 0,
    outputTokens: 0,
  };

  for (const poolOutcome of poolOutcomes) {
    if (!poolOutcome.ok) {
      // 闭包从不抛非 AbortError（上面 catch 住了）——此分支是防御性兜底
      const error = toHarnessError(poolOutcome.error, 'subagent/orchestrator');
      outcomes.push({
        ok: false,
        agent: '?',
        task: '?',
        errorCode: 'internal_error',
        reason: 'run_error',
        message: error.message,
      });
      failCount += 1;
      continue;
    }
    const outcome = poolOutcome.value;
    outcomes.push(outcome);
    if (outcome.ok) {
      okCount += 1;
      totalUsage.inputTokens += outcome.usage.inputTokens;
      totalUsage.outputTokens += outcome.usage.outputTokens;
    } else {
      failCount += 1;
    }
  }

  return { outcomes, okCount, failCount, totalUsage };
}

/** ToolResult → TaskOutcome 的映射（meta 携带的审计字段在此被解析） */
function toTaskOutcome(spec: SubagentTaskSpec, result: ToolResult): TaskOutcome {
  if (result.ok) {
    const meta = result.meta ?? {};
    return {
      ok: true,
      agent: spec.agent,
      task: spec.task,
      summary: result.content,
      usage: extractUsage(meta['usage']) ?? { inputTokens: 0, outputTokens: 0 },
      turns: typeof meta['turns'] === 'number' ? meta['turns'] : 0,
    };
  }
  return {
    ok: false,
    agent: spec.agent,
    task: spec.task,
    errorCode: result.error.code,
    reason: extractReason(result.meta),
    message: result.error.message,
  };
}

/** 从 meta 收窄 Usage（meta 是 Record<string, unknown>——需要运行时校验） */
function extractUsage(raw: unknown): Usage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const candidate = raw as { inputTokens?: unknown; outputTokens?: unknown };
  if (typeof candidate.inputTokens === 'number' && typeof candidate.outputTokens === 'number') {
    return { inputTokens: candidate.inputTokens, outputTokens: candidate.outputTokens };
  }
  return undefined;
}

/** 从 meta 收窄 TaskFailureReason（未知值统一折叠为 run_error——诚实兜底） */
function extractReason(meta: Readonly<Record<string, unknown>> | undefined): TaskFailureReason {
  const raw = meta?.['reason'];
  if (typeof raw === 'string' && FAILURE_REASONS.includes(raw)) {
    return raw as TaskFailureReason;
  }
  return 'run_error';
}

// ===========================================================================
// §2 createOrchestratorTool —— 模型驱动的 fan-out
// ===========================================================================

/** spawn 工具的输入 schema（父模型可见的 API 面） */
const SpawnTasksSchema = z.object({
  tasks: z
    .array(
      z.object({
        agent: z.string().min(1).describe('执行该任务的子代理名（见可用子代理目录）'),
        task: z.string().min(1).describe('自包含的任务描述（子代理看不到主对话）'),
      }),
    )
    .min(1)
    .describe('要并发分派的任务列表（彼此必须独立，不要有数据依赖）'),
});

export interface OrchestratorToolOptions {
  readonly definitions: readonly SubAgentDefinition[];
  readonly deps: SubAgentDeps;
  /** 工具名覆盖（缺省 'spawn_subagents'）——注册进父 registry 时的命名 */
  readonly name?: string;
}

/**
 * 把 runSubagents 包装为模型可调用的工具——「父模型自主拆任务并发派发」。
 *
 * 与单个 AgentTool 的分工：
 *   - AgentTool：模型说「派一个专家干这件事」（一对一直派）；
 *   - OrchestratorTool：模型说「这件事拆成三份，并发派给三个专家」
 *     （一对多编排）——它内部不做调度创新，只是 runSubagents 的协议适配。
 */
export function createOrchestratorTool(
  options: OrchestratorToolOptions,
): Tool<{ tasks: { agent: string; task: string }[] }> {
  const agentNames = options.definitions.map((d) => d.name).join(', ');
  return {
    name: options.name ?? 'spawn_subagents',
    description:
      `把多个**彼此独立**的子任务并发分派给子代理执行，返回各任务的结算报告。` +
      `可用子代理：${agentNames || '（无）'}。` +
      '注意：子任务之间不要有数据依赖（需要前一个的输出时，请依次调用对应子代理）。',
    inputSchema: SpawnTasksSchema,
    risk: 'medium',
    timeoutMs: options.deps.config.subagent.taskTimeoutMs + 5_000, // 外层必须晚于单任务内层超时
    async execute(input, ctx: ToolContext): Promise<ToolResult> {
      const report = await runSubagents({
        deps: options.deps,
        definitions: options.definitions,
        tasks: input.tasks,
        signal: ctx.signal, // 父取消 → 池停止调度（AbortError 穿透回父 Loop）
        context: {
          sessionId: ctx.sessionId,
          queryId: ctx.queryId,
          workingDir: ctx.workingDir,
        },
      });
      return okResult(renderReport(report), {
        okCount: report.okCount,
        failCount: report.failCount,
        totalUsage: report.totalUsage,
      });
    },
  };
}

/** 报告的文本化（给模型读的形态——失败含修正提示，成功给摘要） */
function renderReport(report: SubagentRunReport): string {
  const lines: string[] = [
    `并发分派完成：成功 ${report.okCount} / 失败 ${report.failCount}（共 ${report.outcomes.length} 个任务）`,
  ];
  report.outcomes.forEach((outcome, i) => {
    if (outcome.ok) {
      lines.push(`\n[${i + 1}] ✓ ${outcome.agent}（${outcome.turns} 轮）\n${outcome.summary}`);
    } else {
      lines.push(`\n[${i + 1}] ✗ ${outcome.agent}：${outcome.message}`);
    }
  });
  if (report.failCount > 0) {
    lines.push('\n对失败的任务：可按提示调整后重试，或对其余任务继续处理。');
  }
  return lines.join('\n');
}
