/**
 * LangGraph 对照层 · 图定义 —— 用 StateGraph 重表达我们的 Agent Loop（w16）。
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 对照方法论：唯一变量是「控制流宿主」                                   │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * 本层刻意**复用我们自己的力量**做对照实验：
 *   - 同一个 LLMProvider（FakeProvider 脚本）——模型侧不变；
 *   - 同一个 Dispatcher（四步执行链）——工具语义不变；
 *   - 同一个 HarnessConfig——预算参数不变。
 *
 * 被替换的只有一件事：**「轮次编排」这段控制流的宿主**——
 *   我们的 AgentLoop：        while(true) + 手工状态累加（counter/数组）
 *   LangGraph 的 StateGraph： 状态机 + 节点 + 条件边（引擎管理状态流转）
 *
 * 两边跑同一场景，结果可以逐字段对照（见 tests/integration/langgraph-adapter.test.ts
 * 与 docs/04-langgraph-comparison.md）。
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 概念对照表（读代码时的翻译词典）                                       │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 *   我们的 AgentLoop                     LangGraph 对应物
 *   ──────────────────────────────────  ─────────────────────────────────
 *   手工可变数组 messages                 State.messages（Annotation + reducer）
 *   usageTotals 手工累加                 State.usage（reducer: 字段相加）
 *   turns += 1                           State.turns（reducer: 加和）
 *   while(true) 循环边界                  START / 节点 / 条件边 / END
 *   轮头检查 turns >= maxTurns           条件边 routeAfterTools（tools→END）
 *   流式 for-await 转发分片              引擎 stream() 模式（本层用 complete，
 *                                        见下方「刻意不对照的部分」）
 *   onTurnEnd 持久化接缝                 checkpointer（每个 super-step 自动存）
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 两条循环路径的完整性检查（与 agent-loop.ts 的语义逐条对齐）             │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 *   我们的 while 循环（maxTurns=M，脚本一直 tool_use）：
 *     model#1 → tools#1 → … → model#M → tools#M → [轮头检查] 停
 *     （注意：第 M 批工具**已执行**——检查发生在轮头而非轮中）
 *
 *   本图的边（必须等价，否则对照实验无效）：
 *     model → [有 toolCalls?] → tools（无条件执行，对齐「轮内执行」）
 *     tools → [turns >= M?] → END / model
 *     轨迹：model#1 → tools#1 → … → model#M → tools#M → turns>=M → END ✓
 *
 *   终止原因推导（runner.ts）：末条 assistant 无 toolCalls → completed；
 *   有 toolCalls 却结束 → 只可能是 tools 后 turns>=M → max_turns。
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 刻意不对照的部分（边界声明）                                           │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * - **流式渲染**：本层节点用 provider.complete（一次拿整段）。我们的 Loop
 *   以「流式转发分片」为核心，而 LangGraph 把流式做成了引擎的 stream()
 *   模式——这是「机制换位」不是「能力缺失」，细节留对照笔记讨论。
 * - **ContextManager 组装**：本层直传消息（对齐 Loop 的直传模式）。
 *   分层预算/压缩是内核模块，挂在节点的函数体里即可调用——对照点在
 *   「谁持有状态」，不在「状态怎么组装」。
 * - **事件总线**：本层不 emit harness 事件（对照聚焦控制流；事件流是
 *   我们内核的横切设计，LangGraph 的等价物是 stream()——见笔记）。
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 依赖与生命周期（ADR：对照层是叶子）                                    │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * - `@langchain/langgraph` 装在 devDependencies：本目录**不被任何核心模块
 *   依赖**（依赖方向：adapters → kernel/tools/config，单向）；整个目录可
 *   连带包依赖一起删除而不影响内核。
 * - checkpointer 缺省 MemorySaver（进程内）；线程 id 用 queryId——
 *   每次 query 独立线程（对照：会话级持久化是我们的 Session 域，见笔记）。
 */

import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import type { HarnessConfig } from '../../config.ts';
import type { Dispatcher } from '../../kernel/dispatcher.ts';
import type { LoopContext } from '../../kernel/agent-loop.ts';
import { MemorySaver } from '@langchain/langgraph';
import type { ToolRegistry } from '../../tools/registry.ts';
import type { LLMProvider, LLMRequest, Message, Usage } from '../../types.ts';
import { toolMessage } from '../../types.ts';

// ===========================================================================
// §1 状态定义（对照：Loop 内部的「手工可变状态」）
// ===========================================================================

/**
 * reducer 语义速记：节点返回的 patch 值会与原值经 reducer 合并。
 *   - messages：拼接（对应 Loop 里 messages.push(...)）
 *   - turns / usage：加和（对应 usageTotals 手工累加；节点返回「本轮的增量」）
 * default 只在**本字段未出现在 invoke 输入中**时生效。
 */
const LoopState = Annotation.Root({
  messages: Annotation<Message[]>({
    reducer: (previous, patch) => previous.concat(patch),
    default: () => [],
  }),
  turns: Annotation<number>({
    reducer: (previous, patch) => previous + patch, // 节点返回 1 = 模型调用一次
    default: () => 0,
  }),
  usage: Annotation<Usage>({
    reducer: (previous, patch) => ({
      inputTokens: previous.inputTokens + patch.inputTokens,
      outputTokens: previous.outputTokens + patch.outputTokens,
    }),
    default: () => ({ inputTokens: 0, outputTokens: 0 }),
  }),
});

/** 供 runner 使用的状态值类型（invoke 的输入/返回都长这样） */
export type LoopGraphState = typeof LoopState.State;

// ===========================================================================
// §2 图工厂（节点 = Loop 的一步；边 = 循环的走向）
// ===========================================================================

export interface LoopGraphDeps {
  readonly provider: LLMProvider;
  /** 与 AgentLoop 使用同一个实例：工具执行语义（权限/hooks/超时）完全一致 */
  readonly dispatcher: Dispatcher;
  readonly registry: ToolRegistry;
  readonly config: HarnessConfig;
  /** 运行环境（sessionId/queryId/workingDir/signal）——结构化对齐 LoopContext */
  readonly ctx: LoopContext;
  /**
   * checkpoint 存储：undefined = 缺省 MemorySaver（进程内）；
   * null = 显式不挂（abort 恢复不可用，见 runner.ts）。
   */
  readonly checkpointer?: BaseCheckpointSaver | null;
}

/**
 * 构建并编译 Loop 图。
 *
 * 节点在闭包里捕获 deps——这正是 LangGraph 的「依赖注入方式」：
 * 图只描述**编排拓扑**，依赖（模型/工具/配置）从外部注入节点函数。
 * 对照我们内核：AgentLoop 把依赖收在构造器里，Dispatcher 每轮被调用——
 * 注入位置不同，注入内容一致。
 */
export function createLoopGraph(deps: LoopGraphDeps) {
  const { provider, dispatcher, registry, config, ctx } = deps;

  // ---- 节点 1：模型轮（对照 Loop 的步骤 1-2：组装请求 + 流式调用）----
  const modelNode = async (state: LoopGraphState): Promise<Partial<LoopGraphState>> => {
    // 轮头取消检查（对齐 Loop 步骤 0 的优先级：取消先于预算）
    if (ctx.signal.aborted) {
      throw new DOMException('query 已被取消（轮头检查）', 'AbortError');
    }
    const request: LLMRequest = {
      model: config.llm.defaultModel,
      messages: [...state.messages], // 直传模式：ContextManager 组装可在此处插入
      tools: registry.toToolSpecs(),
      maxOutputTokens: config.context.reservedOutputTokens,
      signal: ctx.signal,
    };
    const response = await provider.complete(request);
    // patch：消息 +1 条（reducer 拼接）、轮次 +1、用量并入（reducer 相加）
    return { messages: [response.message], turns: 1, usage: response.usage };
  };

  // ---- 节点 2：工具批（对照 Loop 的步骤 4-5：串行执行 + 写回）----
  const toolsNode = async (state: LoopGraphState): Promise<Partial<LoopGraphState>> => {
    const last = state.messages[state.messages.length - 1];
    if (last === undefined || last.role !== 'assistant' || last.toolCalls === undefined) {
      return {}; // 防御：拓扑上不可达（tools 只接在带 toolCalls 的 model 之后）
    }
    const results: Message[] = [];
    for (const call of last.toolCalls) {
      // 串行执行（对齐 Loop 决策 ③）；AbortError 从 Dispatcher 穿透向上
      const result = await dispatcher.dispatch(call, ctx);
      results.push(toolMessage(call.id, call.name, result.content));
    }
    return { messages: results };
  };

  // ---- 条件边（对照 Loop 的三个循环出口）----
  /** model 之后：有工具调用 → tools；没有 → 自然终结（completed） */
  const routeAfterModel = (state: LoopGraphState): 'tools' | typeof END => {
    const last = state.messages[state.messages.length - 1];
    if (last !== undefined && last.role === 'assistant' && (last.toolCalls?.length ?? 0) > 0) {
      return 'tools';
    }
    return END;
  };
  /**
   * tools 之后：轮次达到上限 → 终结（max_turns）；否则回模型。
   * 语义锚点：此刻等价于我们 Loop「回到循环头部后的检查」——第 M 批工具
   * 已执行，才轮到「还能不能再开一轮」的判断。
   */
  const routeAfterTools = (state: LoopGraphState): 'model' | typeof END => {
    return state.turns >= config.loop.maxTurns ? END : 'model';
  };

  const checkpointer =
    deps.checkpointer === undefined ? new MemorySaver() : (deps.checkpointer ?? undefined);

  const graph = new StateGraph(LoopState)
    .addNode('model', modelNode)
    .addNode('tools', toolsNode)
    .addEdge(START, 'model')
    .addConditionalEdges('model', routeAfterModel, ['tools', END])
    .addConditionalEdges('tools', routeAfterTools, ['model', END])
    .compile(checkpointer === undefined ? {} : { checkpointer });

  return graph;
}

/** 编译产物的类型别名（写测试与 runner 时用） */
export type LoopGraph = ReturnType<typeof createLoopGraph>;
