/**
 * createAgentTool —— 把「子代理定义」变成一个标准 Tool（Agent-as-Tool 的实现核心）。
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 执行全景（一次子代理任务的完整生命周期）                              │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 *   execute({ task }, ctx)                          ← 父 Dispatcher 驱动
 *     │
 *     ├─ 0. 外部取消快速检查（ctx.signal 已 aborted → 直接抛 AbortError）
 *     │
 *     ├─ 1. 建立「内部取消通道」：controller + 双计时源
 *     │      ├─ 外部取消桥接：父 signal.abort → controller.abort（级联取消）
 *     │      └─ 内部超时定时器：taskTimeoutMs 到时 → timedOut=true + abort
 *     │      （两条路径都收敛到同一个 controller——子世界只需尊重一个 signal）
 *     │
 *     ├─ 2. 组装子世界（每次 run 全新实例——隔离性的物理保证）
 *     │      provider（工厂新建）
 *     │        + childDispatcher（复用父的 hooks/permission——横切策略不豁免）
 *     │        + childContextManager（独立预算视图，count 用子 provider 的 tokenizer）
 *     │        + childAgentLoop（独立 systemPrompt + 空历史 + 独立 maxTurns）
 *     │
 *     ├─ 3. emit subagent_started（父视角事实；子世界内部事件带派生 queryId）
 *     │
 *     ├─ 4. 消费子循环事件流（for await 背压驱动；文本增量**不转发**父世界——
 *     │      隔离层 4：只有最终摘要回传）
 *     │
 *     └─ 5. 结果映射（五路）：
 *            completed          → okResult(摘要, meta{usage,turns,...})
 *            max_turns          → failedResult('service_error', 建议拆小任务)
 *            aborted + timedOut → failedResult('timeout', 建议缩小范围)
 *            aborted + 外部取消 → **throw AbortError 穿透**（取消是控制流）
 *            run_error（异常）  → failedResult('internal_error', 原始信息)
 *
 * ─────────────────────────────────────────────────────────────────────
 * 设计决策备案（grill 高频问题）：
 *
 * ① 为什么内部超时转「失败结果」而外部取消「穿透 AbortError」？
 *    语义不同：内部超时是**这个子任务自己的失败**（工具级事实——父模型
 *    应该看到「超时了」并决定拆小/换路，错误即数据）；外部取消是**整个
 *    会话被叫停**（控制流——父 Loop 要把「用户中断」上传为 aborted 终态）。
 *    把外部取消伪装成工具失败会让父模型以为「可以重试」，实则用户已走。
 *
 * ② 为什么外层 Dispatcher 超时 = taskTimeoutMs + 缓冲？
 *    双层超时的触发顺序必须是「内层先响」：内层是协作式取消（真正 abort
 *    子循环、资源回收干净）；外层是 Promise.race 保护（丢下僵尸 promise）。
 *    若外层先响：子循环被丢下继续跑（僵尸），且事件流错位。
 *    缓冲 5s 给「子循环收到 abort 后的收敛时间」（补占位/记账/收尾）。
 *
 * ③ 为什么 childDispatcher 复用父的 hooks / permission？
 *    见 types.ts 的「关键决策二」：横切策略是全局的，不因执行者身份豁免。
 *    权限的第一道防线已经在**工具子集**（结构收窄），hook 链是第二道。
 *
 * ④ 为什么子世界的文本增量不转发给父 CLI？
 *    隔离层 4（types.ts）：只有结论进父世界。进度展示是可观测层的事——
 *    诊断事件里能看到子世界的完整轨迹（派生 queryId 可归因）。若未来
 *    CLI 想画嵌套进度树，订阅 bus 即可，本文件零改动。
 *
 * 已知缺口（显式标注，演进点）：
 *   - 子循环抛致命异常时 LoopResult 不可得 → usage 丢失（只有 bus 上
 *     各轮 llm_response 事件的 usage 可用于事后重算）。演进方向：Loop
 *     异常路径也产出「残缺 result」或统一走 usage_recorded 事件。
 *
 * 依赖方向：subagent/agent-tool.ts → subagent/types + kernel(AgentLoop/
 *           Dispatcher/events) + context/manager + tools/registry + types/errors/config。
 */

import { z } from 'zod';
import type { HarnessConfig } from '../config.ts';
import { ContextManager } from '../context/manager.ts';
import { HarnessError, isAbortError, toHarnessError } from '../errors.ts';
import { AgentLoop } from '../kernel/agent-loop.ts';
import type { LoopResult } from '../kernel/agent-loop.ts';
import { Dispatcher } from '../kernel/dispatcher.ts';
import { ToolRegistry } from '../tools/registry.ts';
import type { Tool, ToolContext, ToolResult } from '../types.ts';
import { failedResult, okResult } from '../types.ts';
import type { SubAgentDefinition, SubAgentDeps, TaskFailureReason } from './types.ts';

// ===========================================================================
// §1 输入协议
// ===========================================================================

/**
 * 子代理工具的输入 schema（父模型可见的 API 面）。
 * 「自包含」是给模型的关键提示：子代理看不到主对话——任务描述必须
 * 自带全部前置信息（这是使用子代理最容易犯的错，schemadescribe 里说明）。
 */
const AgentTaskSchema = z.object({
  task: z
    .string()
    .min(1)
    .describe('交给子代理的完整任务描述。注意：子代理看不到主对话历史，描述必须自包含。'),
});

// ===========================================================================
// §2 工厂
// ===========================================================================

/** 外层 Dispatcher 超时相对内部超时的缓冲（毫秒）——见文件头决策 ② */
const DISPATCHER_TIMEOUT_BUFFER_MS = 5_000;

/**
 * 把子代理定义编译成一个标准 Tool。
 *
 * 构造期（纯装配，无副作用）+ 运行期（每次 execute 全新子世界）严格分离：
 *   - 构造期做**全部可以提前暴露的错误**（未知工具名 → config_error）；
 *   - 运行期只做每次任务才可知的事（超时、取消、子循环执行）。
 */
export function createAgentTool(
  definition: SubAgentDefinition,
  deps: SubAgentDeps,
): Tool<{ task: string }> {
  const now = deps.now ?? Date.now;

  // ---- 构造期 1/3：工具子集过滤（隔离层 3 的结构基础）----
  // 未知工具名 = 装配错误：立即抛 config_error（不学「容错跳过」——
  // 静默跳过会让子代理「少了一把工具」直到运行期才暴露，归因困难）。
  const childRegistry = new ToolRegistry();
  const selectedTools =
    definition.toolNames === undefined
      ? deps.tools.list() // 缺省 = 继承父的全部工具（放弃最小权限——见 types.ts 注释）
      : definition.toolNames.map((name) => {
          const tool = deps.tools.get(name);
          if (tool === undefined) {
            throw new HarnessError(
              'config_error',
              `子代理 "${definition.name}" 引用了未注册的工具 "${name}"`,
              { where: 'subagent/agent-tool' },
            );
          }
          return tool;
        });
  for (const tool of selectedTools) childRegistry.register(tool);

  // ---- 构造期 2/3：子循环 config（maxTurns 覆盖）----
  // 浅拷贝说明：config 本体是深冻结的，浅拷贝产生「只改 loop 一层」的
  // 派生对象——AgentLoop 只读 config，不会触碰其余共享引用，安全。
  const maxTurns = definition.maxTurns ?? deps.config.subagent.maxTurns;
  const childConfig: HarnessConfig = { ...deps.config, loop: { ...deps.config.loop, maxTurns } };

  // ---- 构造期 3/3：超时预算（内层 + 缓冲 = 外层申报值）----
  const taskTimeoutMs = definition.timeoutMs ?? deps.config.subagent.taskTimeoutMs;

  return {
    name: definition.name,
    description: definition.description,
    inputSchema: AgentTaskSchema,
    /**
     * 风险级固定为 medium 的取舍：子代理本身是「计算服务」（无直接副作用），
     * 但它**代理执行**的所有真实操作会走子 Dispatcher 的权限链（真正把关处）。
     * 演进点：若某类子代理的聚合风险显著更高（如「运维代理」），
     * 可在定义里加 risk 覆盖字段。
     */
    risk: 'medium',
    // 外层保护必须晚于内层协作式超时触发（文件头决策 ②）
    timeoutMs: taskTimeoutMs + DISPATCHER_TIMEOUT_BUFFER_MS,

    async execute(input: { task: string }, ctx: ToolContext): Promise<ToolResult> {
      const { task } = input;

      // ---- 步骤 0：外部已取消 → 快速失败（零资源分配）----
      if (ctx.signal.aborted) {
        throw new DOMException(`子代理 "${definition.name}" 在启动前已被取消`, 'AbortError');
      }

      // ---- 步骤 1：内部取消通道（外部桥接 + 内部超时 → 单一 controller）----
      const controller = new AbortController();
      let timedOut = false;
      const onExternalAbort = (): void => controller.abort();
      ctx.signal.addEventListener('abort', onExternalAbort, { once: true });
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, taskTimeoutMs);

      // ---- 步骤 2：组装子世界（全部实例每次任务新建——隔离的物理保证）----
      const provider = deps.providerFactory(definition);
      const childDispatcher = new Dispatcher({
        registry: childRegistry,
        hooks: deps.hooks, // 复用：横切策略不豁免（文件头决策 ③）
        permission: deps.permission, // 复用：同上
        bus: deps.bus,
        config: childConfig,
        now,
      });
      const childContextManager = new ContextManager({
        config: childConfig.context,
        count: (text) => provider.countTokens(text), // 独立 tokenizer（预算视图与子 provider 一致）
        bus: deps.bus,
      });
      const childLoop = new AgentLoop({
        provider,
        dispatcher: childDispatcher,
        registry: childRegistry,
        bus: deps.bus,
        config: childConfig,
        contextManager: childContextManager,
        systemPrompt: definition.systemPrompt, // 隔离层 2：独立人格
        now,
      });

      // 子世界的 queryId 派生自父 queryId：诊断事件可用前缀匹配归因
      // （`q_xxx>researcher` 一眼看出是 q_xxx 这次提问派生的子工作）。
      const childCtx = {
        sessionId: ctx.sessionId, // 会话不派生：子代理是会话内的派生工作
        queryId: `${ctx.queryId}>${definition.name}`,
        workingDir: ctx.workingDir,
        signal: controller.signal, // 子世界只看内部信号（外部取消已桥接进来）
      };

      deps.bus.emit({
        type: 'subagent_started',
        subagent: definition.name,
        taskLength: task.length, // 隐私约定：只记长度，任务原文不入事件
        sessionId: ctx.sessionId,
        queryId: ctx.queryId,
      });

      // ---- 步骤 3：运行子循环 + 消费事件流 ----
      // 结果变量在 finally 的记账里使用——初始化保证「异常路径也有默认值」
      let result: LoopResult | undefined;
      let runError: HarnessError | undefined;
      let finalOk = false;

      /**
       * 失败结果统一附加审计 meta（meta 不进模型上下文，专供 hook / 可观测 /
       * orchestrator 消费）。reason 是子代理域的精细归因码——orchestrator
       * 靠它把 ToolResult 映射回 TaskOutcome（两只码并存的分工见 types.ts）。
       */
      const tagFailure = (failure: ToolResult, reason: TaskFailureReason): ToolResult => ({
        ...failure,
        meta: { agent: definition.name, reason },
      });

      try {
        try {
          for await (const event of childLoop.run(task, [], childCtx)) {
            // 背压消费：必须把整个事件流拉完，子循环才会推进到终态。
            // 文本增量/工具活动**不转发**父世界（文件头决策 ④）——只留终态。
            if (event.type === 'completed') result = event.result;
            void event;
          }
        } catch (raw) {
          if (isAbortError(raw)) {
            // 契约上 AbortError 已被子 Loop 收敛为 aborted 终态；走到这里
            // 说明取消发生在「Loop 收敛之外」（极端路径）——与 aborted
            // 同语义处理：下方统一判定（timedOut ? timeout : 穿透）。
          } else {
            runError = toHarnessError(raw, 'subagent/agent-tool');
          }
        }

        // ---- 步骤 4：结果映射（五路，见文件头执行全景）----
        if (runError !== undefined) {
          // 注：此路径 usage 不可得（已知缺口，见文件头）——meta 里省略
          return tagFailure(
            failedResult(
              'internal_error',
              `子代理 "${definition.name}" 运行异常: ${runError.message}`,
              `子代理 "${definition.name}" 在执行中遇到内部故障，任务未完成。可以稍后重试，或改用更小的任务。`,
            ),
            'run_error',
          );
        }
        if (result === undefined) {
          return tagFailure(
            failedResult('internal_error', `子代理 "${definition.name}" 未产出终态（契约破坏）`),
            'run_error',
          );
        }

        switch (result.stopReason) {
          case 'completed': {
            finalOk = true;
            const summary = result.finalMessage?.content ?? '（子代理未产出文本回复）';
            return okResult(summary, {
              // meta 不进模型上下文（ToolResult 注释的约定）——给 hook/可观测层
              agent: definition.name,
              turns: result.turns,
              usage: result.usage, // 单轨分账：子代理用量独立上报（必答问题 ②）
              stopReason: result.stopReason,
            });
          }
          case 'max_turns':
            return tagFailure(
              failedResult(
                'service_error',
                `子代理 "${definition.name}" 达到轮次上限（${maxTurns} 轮）仍未完成任务`,
                `子代理 "${definition.name}" 达到轮次上限（${maxTurns} 轮），任务未完成。` +
                  '请把任务拆解得更小、更明确，或分多次调用。',
              ),
              'max_turns',
            );
          case 'aborted':
            if (timedOut) {
              return tagFailure(
                failedResult(
                  'timeout',
                  `子代理 "${definition.name}" 超时（${taskTimeoutMs}ms）`,
                  `子代理 "${definition.name}" 执行超时（${taskTimeoutMs}ms），任务未完成（已中断）。` +
                    '请缩小任务范围，或分多次调用。',
                ),
                'timeout',
              );
            }
            // 外部取消（用户中断 / 会话中止）：控制流穿透——
            // 不转结果（文件头决策 ①），让父 Loop 收敛为 aborted。
            throw new DOMException(`子代理 "${definition.name}" 随会话取消而中止`, 'AbortError');
          case 'error':
            // Loop 的 error 终态只用于 finally 记账（致命异常已向上抛并被
            // 上面的 catch 捕获）——正常到不了这里，防御性兜底：
            return tagFailure(
              failedResult('internal_error', `子代理 "${definition.name}" 异常终止`),
              'run_error',
            );
          default: {
            // 穷尽检查：未来 LoopStopReason 新增值时这里编译报错
            const exhaustive: never = result.stopReason;
            return tagFailure(
              failedResult('internal_error', `未知终止原因: ${String(exhaustive)}`),
              'run_error',
            );
          }
        }
      } finally {
        // ---- 统一收尾：资源清理 + 事实记账（成功/超时/取消/异常四路都经过）----
        clearTimeout(timeoutTimer);
        ctx.signal.removeEventListener('abort', onExternalAbort);
        deps.bus.emit({
          type: 'subagent_finished',
          subagent: definition.name,
          ok: finalOk,
          // usage 可选：成功/超时/max_turns 路径可得；异常路径不可得（已知缺口）
          ...(result !== undefined ? { usage: result.usage } : {}),
          sessionId: ctx.sessionId,
          queryId: ctx.queryId,
        });
      }
    },
  };
}

// ===========================================================================
// §3 批量编译与注册（两个消费者的共享入口）
// ===========================================================================

/** 编译产物：目录（名字→定义）+ 实例表（名字→工具） */
export interface CompiledAgentTools {
  readonly catalog: ReadonlyMap<string, SubAgentDefinition>;
  readonly tools: ReadonlyMap<string, Tool<{ task: string }>>;
}

/**
 * 批量编译子代理定义（两个消费者的共享前置）：
 *   - registerAgentTools：把子代理暴露为**父模型可调用**的工具（注册进父 registry）；
 *   - orchestrator：编程式 fan-out（不进父 registry，直接驱动工具实例）。
 * 编译是纯装配（createAgentTool 无副作用），编译一次可反复执行——
 * 因此 orchestrator 可安全缓存实例表。
 *
 * 重名保护在编译期完成：重名 = 装配错误，直接抛 config_error。
 */
export function compileAgentTools(
  definitions: readonly SubAgentDefinition[],
  deps: SubAgentDeps,
): CompiledAgentTools {
  const catalog = new Map<string, SubAgentDefinition>();
  const tools = new Map<string, Tool<{ task: string }>>();
  for (const definition of definitions) {
    if (catalog.has(definition.name)) {
      throw new HarnessError('config_error', `子代理名重复: "${definition.name}"`, {
        where: 'subagent/agent-tool',
      });
    }
    catalog.set(definition.name, definition);
    tools.set(definition.name, createAgentTool(definition, deps));
  }
  return { catalog, tools };
}

/**
 * 把子代理批量注册为父 registry 中的工具（模型驱动的调用路径）。
 * 返回「名字 → 定义」目录（供需要解析任务引用的调用方使用）。
 *
 * 重名保护：注册重复时 ToolRegistry 抛 config_error——这里不吞不绕。
 */
export function registerAgentTools(
  registry: ToolRegistry,
  definitions: readonly SubAgentDefinition[],
  deps: SubAgentDeps,
): ReadonlyMap<string, SubAgentDefinition> {
  const { catalog, tools } = compileAgentTools(definitions, deps);
  for (const tool of tools.values()) registry.register(tool);
  return catalog;
}
