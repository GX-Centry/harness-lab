/**
 * CLI 组装层（w17）—— 「剥光外壳」的反面：把全栈拼成可交互的产品形态。
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 组装层的三个实例（同一套模块，三种拼法——这是「组装是设计」的证明）     │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 *   scripts/lab.ts 的 bootProcess   演示装配：15 步 → 每一幕换脚本、查诊断
 *   src/eval 的 createCoreRig       剥光装配：只拼内核、固定标识、可断言
 *   src/cli 的 createCliApp         产品装配：交互循环 + 确认通道 + 持久库
 *
 * 三者共用同一册「零件目录」（模块出口），差别只在：拼多少、怎么拼、为谁拼。
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 可测性设计：REPL 的「芯」与「壳」分离                                  │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 *   handleLine(line, signal) —— 一行输入 → CliOutput 事件流（**纯逻辑**：
 *   不碰 readline、不碰 stdout，可被测试直接驱动）；
 *   repl.ts / main.ts        —— 壳：readline 接线、渲染、信号处理。
 *
 * 与「命令路由先于 LLM」的管道约定完全一致：
 *
 *   line ──> commandRouter.tryHandle ──命中──> CliOutput(kind:'command')
 *     │                                    （不进模型、不进会话）
 *     └──未命中──> manager.runQuery ──> CliOutput(kind:'loop')…（原样透传
 *                  LoopEvent，含 completed 信封；致命异常向上抛——与
 *                  runQuery 的语义一致，由外壳决定怎么显示）
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ Provider 替换点（唯一）                                               │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * options.provider 是**整个 CLI 唯一的模型来源开关**：
 *   缺省 = createDemoProvider()（规则驱动、离线确定——见 demo.ts）；
 *   传入自实现 LLMProvider = 接真实模型（装配层零改动——接口在此兑现）。
 *   子代理的 Provider 由 options.subagentProviderFactory 单独指定
 *   （缺省 = 子世界演示规则；理由见 demo.ts）。
 */

import { randomUUID } from 'node:crypto';
import {
  CommandRegistry,
  CommandRouter,
  createBuiltinCommands,
} from '../commands/index.ts';
import { defineConfig } from '../config.ts';
import type { HarnessConfig } from '../config.ts';
import { ContextManager } from '../context/manager.ts';
import { createDefaultHooks } from '../hooks/builtin/index.ts';
import { HookPipeline } from '../hooks/pipeline.ts';
import { AgentLoop } from '../kernel/agent-loop.ts';
import type { LoopEvent } from '../kernel/agent-loop.ts';
import { Dispatcher } from '../kernel/dispatcher.ts';
import { EventBus } from '../kernel/events.ts';
import { MemoryManager } from '../memory/manager.ts';
import { MemoryStore } from '../memory/store.ts';
import { PermissionGate } from '../permission/gate.ts';
import type { ConfirmHandler } from '../permission/gate.ts';
import { SessionManager } from '../session/session-manager.ts';
import type { ResumeInfo } from '../session/session-manager.ts';
import { SessionStore } from '../session/store.ts';
import { SkillRegistry, SkillRunner, createBuiltinSkills } from '../skills/index.ts';
import type { SkillServices } from '../skills/index.ts';
import { registerAgentTools } from '../subagent/index.ts';
import type { SubAgentDefinition, SubAgentDeps } from '../subagent/index.ts';
import { createBuiltinTools } from '../tools/builtin/index.ts';
import { ToolRegistry } from '../tools/registry.ts';
import type { LLMProvider } from '../types.ts';
import { createDemoProvider, createSubagentDemoProvider } from './demo.ts';

// ===========================================================================
// §1 输出契约（壳与芯之间的全部词汇——不加第三种）
// ===========================================================================

/**
 * 一行输入产生的输出事件（判别联合，两条管道各一型）：
 *   - command：斜杠命令的结果文本（渲染为完整段落）；
 *   - loop：对话流的 LoopEvent 原样透传（文本增量/工具活动/终态信封）——
 *     渲染策略属于壳（repl/render.ts），芯不做任何预格式。
 */
export type CliOutput =
  | { readonly kind: 'command'; readonly text: string }
  | { readonly kind: 'loop'; readonly event: LoopEvent };

// ===========================================================================
// §2 选项与句柄
// ===========================================================================

export interface CliAppOptions {
  /** SQLite 库路径（会话 + 记忆共享；main.ts 传 resolveStorePath('data/cli.db')） */
  readonly dbPath: string;
  /** 会话 id：指定则复用（不存在则创建）；缺省新建 `cli-<短uuid>` */
  readonly sessionId?: string;
  /**
   * true = 目标会话取「最近一次会话」（--continue 用）；库为空时回落为新建。
   * 与 sessionId 同传时以 sessionId 为准。
   */
  readonly continueLatest?: boolean;
  /**
   * 权限确认通道（注入——依赖倒置：CLI 外壳提供 readline 问答，
   * 测试提供自动批准/拒绝）。**缺省 = 恒拒绝**（fail-safe：无确认通道时
   * medium+ 工具被拒——与 PermissionGate 的默认策略一致）。
   */
  readonly confirm?: ConfirmHandler;
  /** 全量配置（测试可注入小配置；缺省 defineConfig()） */
  readonly config?: HarnessConfig;
  /** 模型来源（唯一替换点；缺省 = 演示规则 Provider） */
  readonly provider?: LLMProvider;
  /** 子代理 Provider 工厂（缺省 = 子世界演示规则） */
  readonly subagentProviderFactory?: () => LLMProvider;
}

/** 组装产物：壳需要的全部句柄 + 芯（handleLine） */
export interface CliApp {
  readonly config: HarnessConfig;
  readonly sessionId: string;
  /**
   * 启动时执行过恢复流程的报告（未恢复 = undefined）。
   * 是否恢复由**会话状态门控**：只有 interrupted / 崩溃残留的 processing
   * 才需要补位（completed / failed 直接以新 query 继续——与 resumeSession
   * 的契约一致）；壳负责把「恢复了什么」展示给用户。
   */
  readonly resumeReport?: ResumeInfo;
  readonly manager: SessionManager;
  readonly commandRouter: CommandRouter;
  readonly bus: EventBus;
  /**
   * 芯：一行输入 → 输出事件流。
   * 空行 = 无输出；致命异常向上抛（壳负责显示与续命）。signal 用于取消
   * 当前 query（壳在 Ctrl+C / 断连时 abort）。
   */
  handleLine(line: string, signal: AbortSignal): AsyncGenerator<CliOutput, void, void>;
  /** 释放句柄（关 SQLite；幂等） */
  dispose(): void;
}

// ===========================================================================
// §3 组装
// ===========================================================================

/**
 * 目标会话解析（只解析 id，不创建——创建与否由调用方判存在性后决定）：
 *   1. 显式 sessionId 优先（已存在 = 复用；不存在 = 首次创建）；
 *   2. continueLatest = true → 取最近一次会话（listSessions 已按最近活动
 *      倒序，取首条即可）；库为空则回落；
 *   3. 兜底：全新 `cli-<短uuid>`。
 */
function resolveSessionId(
  manager: SessionManager,
  options: Pick<CliAppOptions, 'sessionId' | 'continueLatest'>,
): string {
  if (options.sessionId !== undefined) return options.sessionId;
  if (options.continueLatest === true) {
    const newest = manager.listSessions()[0];
    if (newest !== undefined) return newest.id;
  }
  return `cli-${randomUUID().slice(0, 8)}`;
}

export function createCliApp(options: CliAppOptions): CliApp {
  const config = options.config ?? defineConfig();

  // ---- 1. 工具面：内置四件套 + researcher 子代理（Agent-as-Tool）----
  const registry = new ToolRegistry();
  for (const tool of createBuiltinTools()) registry.register(tool);

  // ---- 2. 事件总线 / Hook 管道 / 权限门（横切三件套）----
  const bus = new EventBus();
  const hooks = new HookPipeline({ hooks: createDefaultHooks(config.hooks), bus });
  const permission = new PermissionGate({
    config: config.permission,
    // fail-safe 缺省：无确认通道 = 拒绝（不是放行——安全默认值）
    confirm: options.confirm ?? (() => Promise.resolve(false)),
  });

  // ---- 3. Dispatcher（所有工具调用的唯一入口）----
  const dispatcher = new Dispatcher({ registry, hooks, permission, bus, config });

  // ---- 4. Provider（唯一模型来源）+ ContextManager（出站预算）----
  const provider = options.provider ?? createDemoProvider();
  const contextManager = new ContextManager({
    config: config.context,
    count: (text) => provider.countTokens(text),
    bus,
  });

  // ---- 5. AgentLoop（内核）----
  const loop = new AgentLoop({
    provider,
    dispatcher,
    registry,
    bus,
    config,
    contextManager,
    systemPrompt: '你是 harness-lab 的演示助手，回答简洁、诚实。',
  });

  // ---- 6. 持久化：SessionStore + MemoryStore（同一 SQLite 文件）----
  const store = new SessionStore(options.dbPath);
  const memoryStore = new MemoryStore(options.dbPath);
  const memoryManager = new MemoryManager({ store: memoryStore, config: config.memory, bus });

  // ---- 7. SessionManager（query 编排：持久化接缝 + 记忆接缝的消费方）----
  const manager = new SessionManager({
    store,
    loop,
    bus,
    config,
    workingDir: process.cwd(),
    memory: memoryManager,
  });
  // ---- 7.5 会话就位：解析目标 → 存在判断 → 状态门控恢复 ----
  // 两条真实约束（均为 w10 契约的一部分，装配层必须尊重而非绕过）：
  //   - createSession **不幂等**：同 id 重复创建抛 input_error → 先 getSession；
  //   - resumeSession **只对 interrupted / processing 有意义**（其余状态抛
  //     「无需恢复」）→ 门控调用，而不是无条件调。
  const sessionId = resolveSessionId(manager, options);
  let resumeReport: ResumeInfo | undefined;
  const existing = manager.getSession(sessionId);
  if (existing === undefined) {
    manager.createSession(sessionId); // 新会话（空库 / 首见 id）
  } else if (existing.state === 'interrupted' || existing.state === 'processing') {
    resumeReport = manager.resumeSession(sessionId); // 补位 + 僵尸态修正
  }
  // existing 为 created / completed / failed：无需恢复流程——直接以新 query 继续。

  // ---- 8. 技能层（确定性编排）----
  const skillRegistry = new SkillRegistry();
  for (const skill of createBuiltinSkills()) skillRegistry.register(skill);
  const skillRunner = new SkillRunner({ registry: skillRegistry, tools: registry, dispatcher, bus });
  const skills: SkillServices = { registry: skillRegistry, runner: skillRunner };

  // ---- 9. 命令层（进 LLM 之前拦截）----
  const commandRegistry = new CommandRegistry();
  for (const command of createBuiltinCommands(commandRegistry)) commandRegistry.register(command);
  const commandRouter = new CommandRouter({
    registry: commandRegistry,
    bus,
    buildContext: (sid) => ({
      sessionId: sid,
      manager,
      store,
      contextManager,
      skills,
      workingDir: process.cwd(),
      bus,
      config,
    }),
  });

  // ---- 10. 子代理层（Agent-as-Tool：模型可派 researcher）----
  const subagentDefinitions: readonly SubAgentDefinition[] = [
    {
      name: 'researcher',
      description: '资料调研子代理（工具子集：calculator / echo——适合边界清晰的窄任务）',
      systemPrompt: '你是资料研究员。专注完成派给你的单个任务，最后用一句话给出结论。',
      toolNames: ['calculator', 'echo'],
      maxTurns: 3,
    },
  ];
  const subagentDeps: SubAgentDeps = {
    tools: registry,
    hooks,
    permission,
    bus,
    config,
    providerFactory: options.subagentProviderFactory ?? (() => createSubagentDemoProvider()),
  };
  registerAgentTools(registry, subagentDefinitions, subagentDeps);

  // ---- 11. 芯：一行输入 → 输出事件流 ----
  async function* handleLine(line: string, signal: AbortSignal): AsyncGenerator<CliOutput, void, void> {
    const input = line.trim();
    if (input === '') return;

    // 命令优先：命中则不进模型、不进会话（控制面与对话面的边界）
    const handled = await commandRouter.tryHandle(input, sessionId);
    if (handled !== undefined) {
      yield { kind: 'command', text: handled.text };
      return;
    }

    // 对话路径：LoopEvent 原样透传（含 completed 终态信封）
    for await (const event of manager.runQuery(sessionId, input, signal)) {
      yield { kind: 'loop', event };
    }
  }

  let disposed = false;
  return {
    config,
    sessionId,
    resumeReport,
    manager,
    commandRouter,
    bus,
    handleLine,
    dispose: () => {
      if (disposed) return; // 幂等（与 Tracer/CostTracker.dispose 同一约定）
      disposed = true;
      // 两个独立连接都指向同一库文件（w10/w11 的刻意设计）——逐一关闭；
      // 漏关 MemoryStore 会让文件锁残留（Windows 上后续删除/重开会 EPERM——
      // 集成测试真实踩过），进程退出能兜底，但嵌入/测试场景没有这个兜底。
      store.close();
      memoryStore.close();
    },
  };
}
