/**
 * lab.ts —— 端到端冒烟演示（w17 CLI 之前的「最小可运行装配」）。
 *
 * 运行：pnpm lab
 * 若中文显示乱码：先执行 `chcp 65001` 或
 *   [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
 *
 * 本脚本的双重定位：
 *   1. 冒烟验证：把已完成组件真实组装起来跑确定性场景——「内核真的能跑」的
 *      可执行证据；每接入一个新模块（Context / Session / Memory / CLI），
 *      这里同步更新，读者可以按 git 历史观察「装配的演进」。
 *   2. 装配手册：组件如何接线、事件如何流动、持久化如何落盘——本文件就是
 *      「装配层」的一份参考实现。
 *
 * w10~w14 演示脚本（八幕 + 终幕）：
 *   A. 首问闭环    3 轮工具闭环 → 每个轮次边界原子落盘（data/lab.db）
 *   B. 模拟重启    「进程」重建（内存全丢）→ 从库中读回会话 → 续问。
 *                  这是持久化存在的意义：会话不随进程死亡而消失。
 *   C. 优雅取消    工具启动瞬间 abort → Loop 补位协议随终结提交落盘 → interrupted
 *   D. 硬崩溃注入  手工伪造「进程被强杀」的现场（工具结果缺失 + processing
 *                  残留）→ resumeSession 补位。与 C 对照：C 是「有机会善后
 *                  的取消」，D 是「没机会善后的崩溃」。
 *   E. 跨会话记忆  显式请求触发写入（白名单）→ 新会话检索命中 → profile
 *                  注入 system（记忆是跨会话的——w11 的完整闭环）。
 *   F. 控制面与技能 斜杠命令被 router 拦截（LLM 请求数为零的硬证据）→
 *                  /compact 分层报告展示 L1 压缩 → /skill 确定性编排
 *                  （命令 → runner → dispatcher → 工具 完整接力）。
 *   G. 子代理      模型直派研究员（Agent-as-Tool：子世界隔离四层 + 独立
 *                  记账 + 派生 queryId 归因）→ 编程 fan-out（partial 语义）。
 *   H. 可观测与评测 内联场景（Core Rig：剥光外壳的内核装配）→ Tracer 全量
 *                  追踪 + Cost 账本四维归因 → 内置四场景行为断言报告
 *                  （failed > 0 时退出码非零——评测进 CI 的最小形态）。
 *   终幕：从又一个全新进程读回全部会话与记忆（持久化的最终证据）。
 *
 * 依赖方向：scripts/lab.ts → src/（全部模块）——它是消费方，不是被依赖方。
 */

import { rmSync } from 'node:fs';
import { relative } from 'node:path';
import { createCliApp, createCliRenderer, createDemoProvider } from '../src/cli/index.ts';
import { CommandRegistry, CommandRouter, createBuiltinCommands } from '../src/commands/index.ts';
import { defineConfig } from '../src/config.ts';
import type { DeepPartial, HarnessConfig } from '../src/config.ts';
import { ContextManager } from '../src/context/manager.ts';
import {
  createBuiltinScenarios,
  createCoreRig,
  renderEvalReport,
  runScenarios,
} from '../src/eval/index.ts';
import type { EvalScenario } from '../src/eval/index.ts';
import { AgentLoop } from '../src/kernel/agent-loop.ts';
import type { LoopEvent, LoopResult } from '../src/kernel/agent-loop.ts';
import { Dispatcher } from '../src/kernel/dispatcher.ts';
import type { HarnessEvent } from '../src/kernel/events.ts';
import { EventBus } from '../src/kernel/events.ts';
import { FakeProvider } from '../src/llm/fake-provider.ts';
import type { FakeTurn } from '../src/llm/fake-provider.ts';
import { createDefaultHooks } from '../src/hooks/builtin/index.ts';
import { HookPipeline } from '../src/hooks/pipeline.ts';
import { MemoryManager } from '../src/memory/manager.ts';
import { MemoryStore } from '../src/memory/store.ts';
import { PermissionGate } from '../src/permission/gate.ts';
import { SessionManager } from '../src/session/session-manager.ts';
import { SessionStore, resolveStorePath } from '../src/session/store.ts';
import { SkillRegistry, SkillRunner, createBuiltinSkills } from '../src/skills/index.ts';
import type { SkillServices } from '../src/skills/index.ts';
import { registerAgentTools, runSubagents } from '../src/subagent/index.ts';
import type { SubAgentDefinition, SubAgentDeps } from '../src/subagent/index.ts';
import { createBuiltinTools } from '../src/tools/builtin/index.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { assistantMessage, userMessage } from '../src/types.ts';
import type { Message } from '../src/types.ts';

// ===========================================================================
// 装配工厂：「一个进程」的完整接线
// ===========================================================================

/** 一次装配的产物（本进程活着期间用到的句柄 + 诊断收集） */
interface LabProcess {
  readonly store: SessionStore;
  readonly memoryStore: MemoryStore;
  readonly manager: SessionManager;
  readonly provider: FakeProvider;
  readonly skills: SkillServices;
  readonly commandRouter: CommandRouter;
  /** 子代理装配依赖（幕 G 的 fan-out 演示直接消费） */
  readonly subagentDeps: SubAgentDeps;
  readonly subagentDefinitions: readonly SubAgentDefinition[];
  /** 子代理的独立 Provider（providerFactory 的产物——每次子任务新建） */
  readonly subProviders: FakeProvider[];
  readonly diagnostics: HarnessEvent[];
}

/**
 * 一次装配 = 模拟一个「进程生命周期」。
 *
 * 为什么用工厂而不是顶层变量：w10 的核心语义是「进程会死，会话不死」——
 * 每一幕都整体重新装配（Provider 剧本 / EventBus / Loop 全部重建），
 * 唯一延续是磁盘上的库文件。读者应注意到：没有任何内存对象跨越幕次。
 *
 * 接线顺序即依赖顺序（每一环只消费前面已备好的组件）：
 *   config → registry → bus → hooks → permission → dispatcher
 *   → provider → contextManager → loop → store → memory → manager
 *   → skills → commands
 */
function bootProcess(
  script: readonly FakeTurn[],
  dbPath: string,
  overrides: DeepPartial<HarnessConfig> = {},
  subagentScripts: Readonly<Record<string, readonly FakeTurn[]>> = {},
): LabProcess {
  // ---- 1. 配置（唯一入口）：defineConfig 深合并 + 校验 + 深冻结。
  //         overrides 让幕 F 能调小工具输出阈值（演示压缩链），缺省即全默认。----
  const config = defineConfig(overrides);

  // ---- 2. 工具注册（ToolRegistry 只存不执行——执行权力专属 Dispatcher）----
  const registry = new ToolRegistry();
  for (const tool of createBuiltinTools()) {
    registry.register(tool);
  }

  // ---- 3. 事件总线（诊断通道）：本进程内全量收集，幕末渲染节选 ----
  const bus = new EventBus();
  const diagnostics: HarnessEvent[] = [];
  bus.on('*', (event) => diagnostics.push(event));

  // ---- 4. Hook 管道（默认集合：repeat-guard / audit / redact / truncate）----
  const hooks = new HookPipeline({ hooks: createDefaultHooks(config.hooks), bus });

  // ---- 5. 权限门（w13 起带 confirm 交互：子代理工具是 medium 风险，无确认
  //           通道会被 fail-safe 拒绝——这里模拟「交互式 CLI，用户批准」。
  //           其余 low 风险工具不会走到确认分支，既有幕次输出不变）----
  const permission = new PermissionGate({
    config: config.permission,
    confirm: (request) => {
      console.log(`  [权限] ${request.toolName}（${request.risk}）需要确认 → [演示] 自动批准`);
      return Promise.resolve(true);
    },
  });

  // ---- 6. Dispatcher（四步执行链的唯一入口）----
  const dispatcher = new Dispatcher({ registry, hooks, permission, bus, config });

  // ---- 7. FakeProvider 剧本回放（每幕只写覆盖本幕模型调用的回合）----
  const provider = new FakeProvider({ script });

  // ---- 8. ContextManager（w09）：出站前的预算守门员。
  //        计数函数用 provider.countTokens ——「谁调用模型，谁的量尺」，
  //        预算判断与真实请求使用同一把尺子（装配层的职责）。----
  const contextManager = new ContextManager({
    config: config.context,
    count: (text) => provider.countTokens(text),
    bus,
  });

  // ---- 9. AgentLoop（内核心脏：编排以上所有组件）----
  const loop = new AgentLoop({
    provider,
    dispatcher,
    registry,
    bus,
    config,
    contextManager,
    systemPrompt: '你是 harness-lab 的演示助手。',
  });

  // ---- 10. SessionStore（w10）：SQLite 持久化（消息 + 检查点 + 会话状态）----
  const store = new SessionStore(dbPath);

  // ---- 11. MemoryStore + MemoryManager（w11）：跨会话记忆——
  //         与会话共享同一数据库文件（memories 表），检索/触发挂点由
  //         SessionManager 在 query 生命周期两侧调用。----
  const memoryStore = new MemoryStore(dbPath);
  const memoryManager = new MemoryManager({ store: memoryStore, config: config.memory, bus });

  // ---- 12. SessionManager（w10/w11）：会话状态机 + query 编排 ——
  //         持久化接缝（onTurnEnd）与记忆接缝（检索/触发）的消费方。----
  const manager = new SessionManager({
    store,
    loop,
    bus,
    config,
    workingDir: process.cwd(),
    memory: memoryManager,
  });

  // ---- 13. 技能层（w12）：确定性编排——技能不经过模型，但每个步骤仍
  //          走同一个 Dispatcher（hook/权限/审计照常生效）。----
  const skillRegistry = new SkillRegistry();
  for (const skill of createBuiltinSkills()) {
    skillRegistry.register(skill);
  }
  const skillRunner = new SkillRunner({
    registry: skillRegistry,
    tools: registry,
    dispatcher,
    bus,
  });
  const skills: SkillServices = { registry: skillRegistry, runner: skillRunner };

  // ---- 14. 命令层（w12）：控制面——router 在「进 LLM 之前」拦截斜杠命令。
  //          依赖方向：router 经 buildContext 引用编排层（commands → 内核，
  //          合法方向）；manager 完全不认识 router——内核零改动。----
  const commandRegistry = new CommandRegistry();
  for (const command of createBuiltinCommands(commandRegistry)) {
    commandRegistry.register(command);
  }
  const commandRouter = new CommandRouter({
    registry: commandRegistry,
    bus,
    buildContext: (sessionId) => ({
      sessionId,
      manager,
      store,
      contextManager,
      skills,
      workingDir: process.cwd(),
      bus,
      config,
    }),
  });

  // ---- 15. 子代理层（w13）：Agent-as-Tool + fan-out 编排 ——
  //   装配要点（对照 subagent/types.ts 的隔离四层）：
  //   - providerFactory：每个子任务一个新 Provider 实例——FakeProvider 的
  //     脚本游标是可变状态，共享实例会被并发子任务交错消费；
  //   - hooks / permission 复用父实例：横切策略不因执行者身份而豁免；
  //   - 子世界的工具子集 / systemPrompt / 空历史由 createAgentTool 封闭。----
  const subProviders: FakeProvider[] = [];
  const subagentDefinitions: readonly SubAgentDefinition[] = [
    {
      name: 'researcher',
      description: '资料调研子代理（可计算、可回显——适合边界清晰的窄任务）',
      systemPrompt: '你是资料研究员。专注完成派给你的单个任务，最后用一句话给出结论。',
      toolNames: ['calculator', 'echo'], // 工具子集：结构性安全边界（隔离层 3）
      maxTurns: 3,
    },
  ];
  const subagentDeps: SubAgentDeps = {
    tools: registry,
    hooks,
    permission,
    bus,
    config,
    providerFactory: (agent) => {
      const provider = new FakeProvider({ script: subagentScripts[agent.name] ?? [] });
      subProviders.push(provider);
      return provider;
    },
  };
  // 把子代理注册为父模型可调用的工具（幕 G 的模型直派路径）
  registerAgentTools(registry, subagentDefinitions, subagentDeps);

  return {
    store,
    memoryStore,
    manager,
    provider,
    skills,
    commandRouter,
    subagentDeps,
    subagentDefinitions,
    subProviders,
    diagnostics,
  };
}

// ===========================================================================
// 八幕 + 终幕
// ===========================================================================

async function main(): Promise<void> {
  const dbPath = resolveStorePath('data/lab.db');

  // ---- 重置演示库（含 WAL/SHM 伴生文件）：每次运行从零开始、输出可复现 ----
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
  console.log(`演示库: ${relative(process.cwd(), dbPath)}（已重置）`);

  await actA(dbPath);
  await actB(dbPath);
  await actC(dbPath);
  await actD(dbPath);
  await actE(dbPath);
  await actF(dbPath);
  await actG(dbPath);
  await actH();
  await actI();
  await actFinale(dbPath);

  console.log('');
  console.log('✔ 全部幕次执行完毕——持久化 / 重启续问 / 优雅取消 / 崩溃补位 / 跨会话记忆 / 命令与技能 / 子代理 / 可观测与评测 / CLI 组装 九条路径均已演示。');
}

/**
 * 幕 A：首问闭环 —— 3 轮工具调用，每个轮次边界（工具批完成后）原子落盘。
 * 关注点：SessionManager 编排 + onTurnEnd 快照 → checkpoint。
 */
async function actA(dbPath: string): Promise<void> {
  banner('幕 A：首问闭环（工具调用 ×2 → 3 轮作答）');
  const proc = bootProcess(
    [
      {
        text: '好的，我先算一下 21 × 2。',
        toolCalls: [{ name: 'calculator', args: { expression: '21 * 2' } }],
      },
      {
        text: '结果是 42，现在回显给你。',
        toolCalls: [{ name: 'echo', args: { message: '42' } }],
      },
      { text: '完成：计算得 42，并已回显。' },
    ],
    dbPath,
  );

  proc.manager.createSession('lab-1');
  const result = await runAndRender(proc, 'lab-1', '请先计算 21 * 2，再把结果回显给我');

  if (result !== undefined) {
    console.log('');
    console.log(`（运行摘要）终止=${result.stopReason}，轮次=${result.turns}，用量=${result.usage.inputTokens}/${result.usage.outputTokens} tok`);
    console.log(`（落盘证据）消息链: ${result.messages.map((m) => m.role).join(' → ')}`);
    console.log(`（落盘证据）检查点数=${proc.store.countCheckpoints('lab-1')}（每个轮次边界一个）`);
  }
  renderDiagnostics(proc.diagnostics);
  proc.store.close(); // ---- 模拟进程退出 ----
}

/**
 * 幕 B：模拟进程重启 —— 全新装配（内存全丢），同库文件续问。
 * 关注点：会话状态的持久化读取（listSessions / loadMessages）。
 */
async function actB(dbPath: string): Promise<void> {
  banner('幕 B：模拟进程重启——内存全丢，会话仍在');
  console.log('（本幕所有对象重新装配：Provider 剧本 / EventBus / Loop / Manager；唯一延续 = 库文件）');

  const proc = bootProcess(
    [{ text: '收到——上次的计算结果 42 仍然保存在会话历史里，我们继续。' }],
    dbPath,
  );

  const sessions = proc.manager.listSessions();
  console.log(
    `（重启后）listSessions() → ${sessions.map((s) => `${s.id} [${s.state}, ${s.messageCount} 条消息]`).join('； ')}`,
  );

  await runAndRender(proc, 'lab-1', '我们刚才得出的是多少？');

  console.log(`（落盘证据）lab-1 现有消息 ${proc.store.loadMessages('lab-1').length} 条`);
  renderDiagnostics(proc.diagnostics, 'lifecycle');
  proc.store.close();
}

/**
 * 幕 C：优雅取消 —— 工具启动瞬间 abort（模拟 Ctrl+C）。
 * 关注点：Loop 的补位协议在终止前写入 → 与终态一次原子落盘 → interrupted。
 */
async function actC(dbPath: string): Promise<void> {
  banner('幕 C：优雅取消——工具启动瞬间 abort（模拟 Ctrl+C）');
  const proc = bootProcess(
    [
      {
        text: '好的，我马上回显这条消息……',
        toolCalls: [{ name: 'echo', args: { message: '这条消息会撞上一次中断' } }],
      },
    ],
    dbPath,
  );

  proc.manager.createSession('lab-abort');
  const result = await runAndRender(proc, 'lab-abort', '帮我回显一句话', {
    abortOnToolStart: true,
  });

  console.log('');
  console.log(`（取消后）stopReason=${result?.stopReason}，会话状态=${proc.manager.getSession('lab-abort')?.state}`);
  for (const m of proc.store.loadMessages('lab-abort')) {
    console.log(`（落盘消息）${m.role}: ${m.content.slice(0, 50)}`);
  }
  console.log('（关键）协议完整：assistant(tool_calls) 与 tool 补位结果成对——由 Loop 在终止前写入');

  // 恢复：filled 应为空——补位已在取消时完成，resume 只是幂等确认（对照幕 D）
  const resumed = proc.manager.resumeSession('lab-abort');
  console.log(`（恢复报告）补位工具调用=${JSON.stringify(resumed.filledToolCallIds)}（空 = 无需补位）`);

  renderDiagnostics(proc.diagnostics, 'lifecycle');
  proc.store.close();
}

/**
 * 幕 D：硬崩溃注入 —— 「进程被强杀」的现场复原（不跑 Loop，直接写库）。
 * 关注点：resumeSession 从检查点推导 pending → 补占位 → 状态归一为 interrupted。
 */
async function actD(dbPath: string): Promise<void> {
  banner('幕 D：硬崩溃注入——「进程被强杀」的现场复原');
  console.log('（本幕不跑 Loop：直接向库里写入崩溃瞬间的现场——工具结果缺失 + processing 残留）');

  const proc = bootProcess([], dbPath);

  // 现场构造：模型已声明工具调用，但进程在工具结果落盘前被强杀（kill -9）。
  // 与幕 C 的本质区别：没有任何代码获得「善后机会」（Loop 的补位逻辑没来得及跑）。
  proc.manager.createSession('lab-crash');
  const crashMessages: Message[] = [
    userMessage('帮我把这句话回显出来'),
    assistantMessage('', [
      {
        id: 'c9',
        name: 'echo',
        args: { message: '永远不会到达的回显' },
        argsRaw: '{"message":"永远不会到达的回显"}',
      },
    ]),
  ];
  proc.store.commit({
    sessionId: 'lab-crash',
    deltaMessages: crashMessages,
    checkpoint: { id: 'cp_crash', turn: 1, messages: crashMessages },
    state: 'processing', // ← 崩溃残留：状态停在 processing，等下一次启动来收拾
    keepLast: 5,
  });

  const before = proc.manager.getSession('lab-crash');
  console.log(
    `（注入后）状态=${before?.state}，消息 ${proc.store.loadMessages('lab-crash').length} 条（assistant 声明了 1 个工具调用，结果缺失）`,
  );

  // ---- 恢复：从这里开始就是「下一次启动」的标准动作 ----
  const resumed = proc.manager.resumeSession('lab-crash');
  console.log(
    `（恢复报告）检查点=${shortId(resumed.checkpointId)}，补位工具调用=${JSON.stringify(resumed.filledToolCallIds)}，消息 ${resumed.messageCount} 条`,
  );
  const recovered = proc.store.loadMessages('lab-crash');
  const filler = recovered[recovered.length - 1];
  if (filler !== undefined) {
    const name = filler.role === 'tool' ? filler.name : '-';
    console.log(`（补位消息）${filler.role}(${name}): ${filler.content.slice(0, 80)}`);
  }
  console.log(`（恢复后）状态=${proc.manager.getSession('lab-crash')?.state}——协议已修复为完整配对，可安全续问`);

  renderDiagnostics(proc.diagnostics, 'lifecycle');
  proc.store.close();
}

/**
 * 幕 E：跨会话记忆 —— 显式请求触发写入（白名单），新会话检索命中注入。
 * 关注点：记忆的两个挂点（retrieveFor / considerWrite）与「跨会话」本质。
 */
async function actE(dbPath: string): Promise<void> {
  banner('幕 E：跨会话记忆——显式请求写入，检索命中注入');
  console.log('（本幕装配新增：MemoryStore + MemoryManager——与会话共享同一数据库文件）');

  const proc = bootProcess(
    [
      { text: '好的，已记住。' }, // E1：被显式请求的那次对话
      { text: '按你的偏好：简洁。' }, // E2：检索命中后的回答
    ],
    dbPath,
  );

  // ---- E1：显式记忆请求（白名单 R1：识别 + 提取 + 归档 preference）----
  proc.manager.createSession('lab-memory');
  await runAndRender(proc, 'lab-memory', '请记住：我偏好简洁的回答');
  const records = proc.memoryStore.list();
  console.log(
    `（写入证据）memories 表 ${records.length} 条：${records.map((r) => `[${r.kind}] ${r.content}`).join('； ')}`,
  );
  renderDiagnostics(proc.diagnostics, 'lifecycle'); // E1 侧证据：memory_written 事件

  // ---- E2：全新会话 + 相关提问 → 检索命中 → profile 注入 system ----
  // 要点：这是个新会话——会话历史里没有「记忆」的出处，注入完全来自
  // 检索层（词频覆盖率打分命中）→ 这就是「跨会话」的工程含义。
  const e2 = bootProcess([{ text: '按你的偏好：简洁。' }], dbPath);
  e2.manager.createSession('lab-memory-2');
  await runAndRender(e2, 'lab-memory-2', '我偏好什么回答风格？');

  const lastSystem = e2.provider.requests[e2.provider.requests.length - 1]?.messages[0];
  console.log('');
  console.log('（注入证据）最后一次 LLM 请求的 system 内容：');
  console.log(`    ${(lastSystem?.content ?? '').replaceAll('\n', '\n    ')}`);

  renderDiagnostics(e2.diagnostics, 'lifecycle'); // E2 侧证据：memory_retrieved 事件
  proc.store.close();
  proc.memoryStore.close();
  e2.store.close();
  e2.memoryStore.close();
}

/**
 * 幕 F：控制面与技能 —— 斜杠命令拦截（不进模型）+ 确定性技能编排。
 *
 * 三个证据点（对应 w12 的两个必答问题）：
 *   ① 控制面 vs 数据面：全部命令经 router 拦截执行，LLM 请求数保持不变——
 *      「命令在进 LLM 之前被处理」的硬证据（对照 provider.requests 计数）；
 *   ② /compact 的 dry-run 报告：分层预算 + L1 压缩记录（本幕特意把
 *      toolOutputMaxTokens 调小，让一条长 echo 结果超过阈值触发压缩）；
 *   ③ /skill math-report：命令 → runner → dispatcher → 工具 的完整接力——
 *      确定性编排不经过模型，但工具执行仍走同一条四步链。
 */
async function actF(dbPath: string): Promise<void> {
  banner('幕 F：命令层 + 技能层——控制面拦截与确定性编排');
  // 调小工具输出阈值（默认 1000 tok）：一条 1200 字符（≈300 tok）的 echo
  // 结果将超过阈值——/compact 报告里能看到真实的 L1 压缩记录。
  const proc = bootProcess(
    [
      { text: '回显中……', toolCalls: [{ name: 'echo', args: { message: 'x'.repeat(1200) } }] },
      { text: '完成：长文本已回显。' },
    ],
    dbPath,
    { context: { toolOutputMaxTokens: 100 } },
  );
  proc.manager.createSession('lab-cmd');

  // ---- F0：先跑一次对话（产出超长工具输出，为 /compact 备好素材）----
  await runAndRender(proc, 'lab-cmd', '请把这段长文本原样回显');
  const baseline = proc.provider.requests.length;
  console.log('');
  console.log(`（基线）对话 1 次（含 2 轮）→ LLM 请求数 = ${baseline}`);

  // ---- F1~F7：全部命令经 router 消化（与模型无关的控制面操作）----
  console.log('');
  console.log('  ── 以下输入全部以 "/" 开头：被 CommandRouter 拦截，不进模型 ──');
  await execCommand(proc, 'lab-cmd', '/help');
  await execCommand(proc, 'lab-cmd', '/status');
  await execCommand(proc, 'lab-cmd', '/history 3');
  await execCommand(proc, 'lab-cmd', '/compact');
  await execCommand(proc, 'lab-cmd', '/skill');
  await execCommand(proc, 'lab-cmd', '/skill math-report 21 * 2');
  await execCommand(proc, 'lab-cmd', '/nope');

  // ---- 硬证据：命令没有产生任何新的 LLM 请求 ----
  console.log('');
  console.log(
    `（硬证据）命令执行后 LLM 请求数 = ${proc.provider.requests.length}（与基线相同 → 命令从未进模型）`,
  );

  renderDiagnostics(proc.diagnostics, 'lifecycle');
  proc.store.close();
  proc.memoryStore.close();
}

/**
 * 幕 G：子代理 —— 模型直派（Agent-as-Tool）与编程 fan-out 的对照。
 *
 * 两条驱动路径的证据布局（对应 w13 的两个必答问题）：
 *
 *   G1 模型直派：父模型亲手调用 researcher 工具（父剧本第一回合的 toolCall），
 *      子世界在工具执行内部独立跑完 2 轮（计算 + 结论），只把摘要一行回传：
 *      - 子 Provider 是独立实例：父剧本仅 2 回合，而子实例自己收到 2 次请求
 *        → 「子世界真的在跑」（隔离的物理证据：每次子任务新建实例）；
 *      - 子世界首请求的 system = 研究员人格、消息从零起步（不含父对话）
 *        → 隔离层 1（空历史）/ 2（独立人格）的直接证据；
 *      - 子世界事件带派生 queryId（`父q>researcher`）→ 诊断可归因；
 *      - 父 LoopResult.usage 不含子用量 → 单轨分账：子 usage 在
 *        subagent_finished 事件里（跨层聚合的责任在可观测层）。
 *
 *   G2 编程 fan-out：runSubagents 一次分派 2 个任务（代码驱动，不经父模型）
 *      ——1 个合法 + 1 个未知代理 → partial 语义：失败独立结算，不株连成功者；
 *      报告按输入同序，聚合用量由调用方按需汇总（内核只落事实）。
 */
async function actG(dbPath: string): Promise<void> {
  banner('幕 G：子代理——模型直派（G1）与编程 fan-out（G2）');
  console.log(
    '（本幕装配新增：researcher 定义 + providerFactory——「每个子任务一个新 Provider 实例」是并发正确性的前提）',
  );

  const proc = bootProcess(
    [
      {
        text: '我派研究员去做这个窄任务。',
        toolCalls: [{ name: 'researcher', args: { task: '计算 21 * 2，并给出一句话结论' } }],
      },
      { text: '收到研究员的结论，任务完成。' },
    ],
    dbPath,
    {},
    {
      researcher: [
        {
          text: '我来计算。',
          toolCalls: [{ name: 'calculator', args: { expression: '21 * 2' } }],
        },
        { text: '结论：21 * 2 = 42。' },
      ],
    },
  );
  proc.manager.createSession('lab-sub');

  // ---- G1：模型直派——父模型调用 researcher，子世界在工具内部独立完成 ----
  const result = await runAndRender(proc, 'lab-sub', '帮我弄清 21 * 2 的结果，派研究员去做');
  const subProvider = proc.subProviders[0];
  console.log('');
  console.log(
    `（父记账）终止=${result?.stopReason}，轮次=${result?.turns}，父用量=${result?.usage.inputTokens}/${result?.usage.outputTokens} tok（不含子代理——单轨分账）`,
  );
  console.log(
    `（子世界证据）子 Provider 实例 ${proc.subProviders.length} 个；实例 #0 收到请求 ${subProvider?.requests.length ?? 0} 次（独立实例：FakeProvider 的脚本游标是可变状态，共享会被并发任务交错消费）`,
  );
  const childFirst = subProvider?.requests[0];
  if (childFirst !== undefined) {
    console.log(`（隔离层 2 证据）子世界首请求 system：${childFirst.messages[0]?.content ?? '（无）'}`);
    console.log(
      `（隔离层 1 证据）子世界首请求消息 ${childFirst.messages.length} 条：${childFirst.messages.map((m) => m.role).join(' → ')}（从零开始，不含父对话）`,
    );
  }
  // 派生 queryId 归因：子世界产生的事件都带 `父q>researcher` 前缀
  const parentQueryId = proc.diagnostics.find((e) => e.type === 'query_start')?.queryId ?? '?';
  const childRequests = proc.diagnostics.filter(
    (e) => e.type === 'llm_request' && (e.queryId ?? '').includes('>'),
  );
  console.log(
    `（归因证据）父 queryId=${parentQueryId}；子世界 LLM 请求 ${childRequests.length} 次，其 queryId=${childRequests[0]?.queryId ?? '?'}（父 q > 子代理名——前缀即溯源链）`,
  );
  renderDiagnostics(proc.diagnostics, 'lifecycle');

  // ---- G2：编程 fan-out——不经过父模型的批量分派（partial 语义）----
  console.log('');
  console.log('  ── G2：runSubagents 一次分派 2 个任务（代码驱动，父模型完全不参与）──');
  const g2Mark = proc.diagnostics.length;
  const report = await runSubagents({
    deps: proc.subagentDeps,
    definitions: proc.subagentDefinitions,
    tasks: [
      { agent: 'researcher', task: '复核：计算 21 * 2，并给出一句话结论' },
      { agent: 'ghost', task: '这个子代理并不存在（演示 partial 语义：失败不株连）' },
    ],
    context: { sessionId: 'lab-sub', queryId: 'lab-g2' },
  });
  console.log(
    `（fan-out 报告）成功 ${report.okCount} / 失败 ${report.failCount}（共 ${report.outcomes.length} 个任务，按输入同序）`,
  );
  for (const outcome of report.outcomes) {
    if (outcome.ok) {
      console.log(`  ✓ ${outcome.agent}（${outcome.turns} 轮）: ${outcome.summary.slice(0, 60)}`);
    } else {
      console.log(`  ✗ ${outcome.agent}（code=${outcome.errorCode} / reason=${outcome.reason}）: ${outcome.message}`);
    }
  }
  console.log(
    `（聚合用量）子任务总量 in=${report.totalUsage.inputTokens} / out=${report.totalUsage.outputTokens} tok——内核只落事实，聚合由调用方按需完成`,
  );
  console.log(
    `（实例证据）子 Provider 总数=${proc.subProviders.length}：G1 的 1 个 + G2 成功任务的 1 个（ghost 未启动——引用解析失败发生在执行之前）`,
  );
  renderDiagnostics(proc.diagnostics.slice(g2Mark), 'lifecycle');

  proc.store.close();
  proc.memoryStore.close();
}

/**
 * 幕 H：可观测与评测 —— w14 两层的端到端闭环。
 *
 *   H1 内联场景 → Core Rig（「剥光外壳的内核装配」，对照 bootProcess 的
 *      完整装配）→ Tracer 全量追踪 + Cost 账本：观测组件是纯消费者，
 *      config.observability 开关关掉即零订阅；子世界花费按派生 queryId
 *      归因（w13 的分账设计在账本层「事后变现」）。
 *   H2 内置四场景 → 行为断言报告：断言「行为」而非文本；failed > 0 时
 *      退出码非零——评测作为 CI 门禁的最小形态。
 */
async function actH(): Promise<void> {
  banner('幕 H：可观测与评测（Tracer 追踪 → Cost 归因 → Eval 断言闭环）');

  // ---- H1：内联场景（含子代理）→ 全链路账本 ----
  // 场景即数据：EvalScenario 是一个普通对象——幕 H 就地把它当作「可观测
  // 演示装置」复用（评测与观测本来就共用同一个 rig 装配）。
  const obsScenario: EvalScenario = {
    name: 'lab-h-observability',
    description: '幕 H 演示：一次含子代理的提问 → 全链路账本',
    input: '派研究员计算 6 * 7，然后把结论告诉我',
    script: [
      {
        text: '我派研究员。',
        toolCalls: [{ name: 'researcher', args: { task: '计算 6 * 7，并给出一句话结论' } }],
      },
      { text: '研究员结论已收到：6 * 7 = 42。' },
    ],
    subagents: [
      {
        name: 'researcher',
        description: '资料调研子代理',
        systemPrompt: '你是资料研究员。专注完成派给你的单个任务，最后用一句话给出结论。',
        toolNames: ['calculator'],
        maxTurns: 3,
      },
    ],
    subagentScripts: {
      researcher: [
        { text: '我来计算。', toolCalls: [{ name: 'calculator', args: { expression: '6 * 7' } }] },
        { text: '结论：6 * 7 = 42。' },
      ],
    },
    autoApprovePermissions: true,
    assertions: [], // H1 直接消费证据（断言演示归结在 H2）
  };

  const rig = createCoreRig(obsScenario);
  try {
    const evidence = await rig.run(obsScenario.input);
    const tracer = rig.tracer;
    const cost = rig.cost;
    if (tracer === undefined || cost === undefined) {
      console.log('  [演示脚本异常] 可观测组件未装配（config.observability 默认应为全开）');
      return;
    }

    console.log('');
    console.log(`用户 > ${obsScenario.input}`);
    const mainTools = evidence.loopEvents
      .filter((event) => event.type === 'tool_started')
      .map((event) => event.name)
      .join(', ');
    console.log(
      `（终态）stopReason=${evidence.result?.stopReason}，轮次=${evidence.result?.turns}，主世界工具=[${mainTools}]`,
    );

    // Tracer：留存完整性 + 派生查询视图（子世界活动可归因）
    const mainView = tracer.byQuery(rig.queryId);
    const derivedView = tracer.byQuery(rig.queryId, { includeDerived: true });
    console.log('');
    console.log(
      `（Tracer）全量留存 ${tracer.count} 条事件（received=${tracer.receivedCount}，dropped=${tracer.droppedCount}——环形缓冲，容量可配）`,
    );
    console.log(
      `（Tracer）主 query 视角 ${mainView.length} 条；含派生 queryId（子世界）共 ${derivedView.length} 条——差额 ${derivedView.length - mainView.length} 条即子代理内部活动`,
    );
    console.log(
      `（Tracer）子代理里程碑：subagent_started=${tracer.byType('subagent_started').length} / subagent_finished=${tracer.byType('subagent_finished').length}`,
    );

    // Cost：总账 → 归因维度 → 单向订阅链的终点事件
    const total = cost.total();
    const sub = cost.bySubagent('researcher');
    console.log('');
    console.log(
      `（Cost）总账：${total.calls} 次模型调用，in=${total.inputTokens}/out=${total.outputTokens} tok ≈ $${total.estimatedCostUsd.toFixed(6)}（unpriced=${total.unpricedCalls}）`,
    );
    console.log(
      `（Cost）归因：subagent=researcher → ${sub.calls} 次调用 ≈ $${sub.estimatedCostUsd.toFixed(6)}；主世界 ${total.calls - sub.calls} 次——两条账目可分辨（派生 queryId 解析末段）`,
    );
    console.log(
      `（Cost）单向链终点：usage_recorded ×${tracer.byType('usage_recorded').length}（llm_response → 定价表 → 落账 → 发布；未定价模型只落账不发布——宁缺毋滥）`,
    );
    console.log(
      '（对照）Tracer / CostTracker 均为纯消费者：config.observability 开关关掉 = 零订阅零开销（不是「少收点」，是「不接」）',
    );
  } finally {
    rig.close();
  }

  // ---- H2：内置四场景 → 断言报告 ----
  console.log('');
  console.log('场景即数据 × 断言「行为」而非文本：内置四场景（每场景锚定一个模块能力）批量运行 →');
  const report = await runScenarios(createBuiltinScenarios());
  console.log(`  ${renderEvalReport(report).replaceAll('\n', '\n  ')}`);
  console.log('');
  if (report.failed > 0) {
    process.exitCode = 1;
    console.log('（退出码语义）failed > 0 → process.exitCode = 1——评测报告可直接作为 CI 门禁');
  } else {
    console.log('（退出码语义）全部通过 → exitCode = 0；报告人读、数据可断言、结论可进 CI');
  }
}

/**
 * 幕 I：CLI 形态 —— 同一套模块的第三种拼法（产品装配）。
 *
 * 与 lab 自身（演示装配）的对照：
 *   - lab 是「拆开看」：每幕换脚本、查诊断、断言中间态；
 *   - CLI 是「合起来用」：默认演示规则 Provider、持久库、确认通道、
 *     斜杠命令——零脚本也永远有应答。
 * 本幕用 lab 直驱 CLI 的「芯」（handleLine）——证明这层组装不依赖
 * readline：壳（repl/main.ts）只是可替换的薄外衣（write 注入即终端）。
 */
async function actI(): Promise<void> {
  banner('幕 I：CLI 组装（芯 / 壳分离——产品形态的第三种拼法）');
  const cliDbPath = resolveStorePath('data/cli-lab.db');
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${cliDbPath}${suffix}`, { force: true });
  }

  // ---- 装配：唯一入口 createCliApp。
  //      与 lab 的 bootProcess 对照：默认演示规则 Provider（离线确定）、
  //      confirm 注入「--yes 语义」、其余全默认（真实产品的零配置形态）。
  //      唯一显式调整：分片延迟调小（lab 全流程节奏——默认 18ms 太从容）。
  const app = createCliApp({
    dbPath: cliDbPath,
    provider: createDemoProvider({ chunkDelayMs: 6 }),
    confirm: (request) => {
      console.log(
        `  [权限] ${request.toolName}（${request.risk}）需要确认 → [演示] 自动批准（--yes 语义）`,
      );
      return Promise.resolve(true);
    },
  });
  console.log(`新会话: ${app.sessionId}（库：${relative(process.cwd(), cliDbPath)}）`);

  // ---- 与真实 CLI 完全同一条渲染路径：CliOutput 流 → renderer → stdout。
  //      交互外壳（readline / 信号）在这里被换成「按行喂入」——芯对壳零假设。----
  const renderer = createCliRenderer((text) => process.stdout.write(text));
  const ask = async (line: string): Promise<void> => {
    console.log(`\n> ${line}`);
    for await (const output of app.handleLine(line, new AbortController().signal)) {
      renderer.render(output);
    }
    renderer.endTurn();
  };

  await ask('你好'); // 问候规则：单轮应答
  await ask('计算 123 * 45'); // 工具闭环：calculator
  await ask('帮我调研一下「会话与记忆的接缝」'); // 子代理 fan-out + 权限确认
  await ask('/status'); // 控制面：斜杠命令不进模型

  // ---- 落盘证明：换一个「全新进程」的连接读回同一会话 ----
  const info = app.manager.getSession(app.sessionId);
  console.log(`\n会话状态: ${info?.state} · 持久化消息 ${info?.messageCount} 条`);
  app.dispose(); // 释放两个 SQLite 连接（会话 + 记忆）

  const store = new SessionStore(cliDbPath);
  const sessions = store.listSessions();
  console.log(
    `库内会话 ${sessions.length} 个——下一次 CLI 启动加 --continue 将命中 ${sessions[0]?.id ?? '（无）'}`,
  );
  store.close();
}

/** 终幕：从又一个全新进程读回全部会话与记忆（持久化的最终证据） */
async function actFinale(dbPath: string): Promise<void> {
  banner('终幕：持久化总览（从一个全新进程读回）');
  const store = new SessionStore(dbPath);
  for (const info of store.listSessions()) {
    console.log(
      `- ${info.id} [${info.state}] ${info.messageCount} 条消息，检查点 ${store.countCheckpoints(info.id)} 个`,
    );
    console.log(`    消息链: ${store.loadMessages(info.id).map((m) => m.role).join(' → ')}`);
  }
  store.close();

  // 记忆总览（w11）：跨会话记忆住在同一数据库文件的 memories 表
  const memoryStore = new MemoryStore(dbPath);
  console.log(`memories 表（跨会话记忆）：${memoryStore.count()} 条`);
  for (const record of memoryStore.list()) {
    console.log(`  - [${record.kind}] ${record.content}（来源：${record.sourceSessionId ?? '未知'}）`);
  }
  memoryStore.close();
}

// ===========================================================================
// 渲染与辅助
// ===========================================================================

/** 运行一次 query 并渲染（模拟 CLI 的消费方式：for await + completed 信封） */
async function runAndRender(
  proc: LabProcess,
  sessionId: string,
  input: string,
  options: { readonly abortOnToolStart?: boolean } = {},
): Promise<LoopResult | undefined> {
  console.log('');
  console.log(`用户 > ${input}`);

  const controller = new AbortController();
  let result: LoopResult | undefined;
  for await (const event of proc.manager.runQuery(sessionId, input, controller.signal)) {
    renderEvent(event);
    if (event.type === 'completed') {
      result = event.result;
    }
    if (options.abortOnToolStart === true && event.type === 'tool_started') {
      console.log('  [演示] 工具刚启动 → 模拟用户按 Ctrl+C 触发 abort');
      controller.abort();
    }
  }
  return result;
}

/** 执行一条命令并渲染（模拟 REPL 的「先过 router」消费方式：命令路径不进模型） */
async function execCommand(proc: LabProcess, sessionId: string, input: string): Promise<void> {
  console.log('');
  console.log(`用户 > ${input}`);
  const result = await proc.commandRouter.tryHandle(input, sessionId);
  if (result === undefined) {
    console.log('  [演示脚本异常] 该输入没有被识别为命令——检查前缀拼写');
    return;
  }
  console.log(`  ${result.text.replaceAll('\n', '\n  ')}`);
}

/** LoopEvent 渲染（模拟 CLI：文本增量直出，工具活动打印状态行） */
function renderEvent(event: LoopEvent): void {
  switch (event.type) {
    case 'turn_started':
      console.log(`\n── 第 ${event.turn} 轮 ──`);
      break;
    case 'text_delta':
      process.stdout.write(event.text);
      break;
    case 'thinking_delta':
      break; // 演示：思考流不渲染（真实 CLI 可做次要样式）
    case 'tool_started':
      console.log(`\n  [工具] 调用 ${event.name}(${JSON.stringify(event.args)}) …`);
      break;
    case 'tool_finished': {
      const status = event.result.ok ? '✓' : '✗';
      console.log(`  ${status} ${event.name} 返回: ${event.result.content.slice(0, 80)}`);
      break;
    }
    case 'completed':
      console.log('');
      break;
    default: {
      // 穷尽检查惯用法：新增 LoopEvent 成员而忘记渲染 → 编译期报错
      const unhandled: never = event;
      void unhandled;
      break;
    }
  }
}

/** 诊断过滤器：'all' = 全部事件；'lifecycle' = 只看里程碑事件（会话/记忆/命令/技能） */
type DiagFilter = 'all' | 'lifecycle';

/** HarnessEvent 渲染（EventBus 诊断通道，节选关键事件） */
function renderDiagnostics(events: readonly HarnessEvent[], filter: DiagFilter = 'all'): void {
  console.log('');
  console.log('  ── 诊断事件（EventBus 通道，节选）──');
  for (const event of events) {
    if (filter === 'lifecycle' && !isLifecycleEvent(event.type)) continue;
    switch (event.type) {
      case 'query_start':
        console.log(`[bus] query_start (inputLength=${event.inputLength})`);
        break;
      case 'llm_request':
        console.log(
          `[bus] llm_request (messages=${event.messageCount}, tools=${event.toolCount}, ~${event.approxInputTokens} tok)`,
        );
        break;
      case 'llm_response':
        console.log(
          `[bus] llm_response (stop=${event.stopReason}, toolCalls=${event.toolCallCount}, ${event.latencyMs}ms)`,
        );
        break;
      case 'permission_decision':
        console.log(`[bus] permission_decision (${event.toolName}: ${event.decision})`);
        break;
      case 'tool_finished':
        console.log(`[bus] tool_finished (${event.name}: ok=${event.ok})`);
        break;
      case 'query_end':
        console.log(`[bus] query_end (${event.stopReason}, turns=${event.turns})`);
        break;
      case 'context_built':
        console.log(
          `[bus] context_built (total=${event.totalTokens} tok, compressed=${event.compressed}, layers=${JSON.stringify(event.layerTokens)})`,
        );
        break;
      case 'context_compressed':
        console.log(
          `[bus] context_compressed (L${event.level}: -${event.droppedMessages} 条 / -${event.droppedTokens} tok)`,
        );
        break;
      case 'session_created':
        console.log(`[bus] session_created (${event.sessionId})`);
        break;
      case 'session_state_change':
        console.log(`[bus] session_state_change (${event.from} → ${event.to})`);
        break;
      case 'message_persisted':
        console.log(`[bus] message_persisted (${event.role})`);
        break;
      case 'checkpoint_saved':
        console.log(`[bus] checkpoint_saved (turn=${event.turn}, id=${shortId(event.checkpointId)})`);
        break;
      case 'session_resumed':
        console.log(`[bus] session_resumed (checkpoint=${shortId(event.checkpointId)})`);
        break;
      case 'memory_retrieved':
        console.log(
          `[bus] memory_retrieved (count=${event.count}, topScore=${event.topScore.toFixed(3)})`,
        );
        break;
      case 'memory_written':
        console.log(`[bus] memory_written (${event.kind}, id=${shortId(event.recordId)})`);
        break;
      case 'command_invoked':
        console.log(`[bus] command_invoked (${event.command})`);
        break;
      case 'command_finished':
        console.log(
          `[bus] command_finished (${event.command}: ok=${event.ok}, ${event.durationMs}ms)`,
        );
        break;
      case 'skill_started':
        console.log(`[bus] skill_started (${event.skill})`);
        break;
      case 'skill_finished':
        console.log(`[bus] skill_finished (${event.skill}: ok=${event.ok}, ${event.durationMs}ms)`);
        break;
      case 'subagent_started':
        console.log(`[bus] subagent_started (${event.subagent}, taskLength=${event.taskLength})`);
        break;
      case 'subagent_finished': {
        const usage =
          event.usage !== undefined
            ? `${event.usage.inputTokens}/${event.usage.outputTokens} tok`
            : '不可得（异常路径）';
        console.log(`[bus] subagent_finished (${event.subagent}: ok=${event.ok}, usage=${usage})`);
        break;
      }
      case 'usage_recorded':
        console.log(
          `[bus] usage_recorded (${event.model}: in=${event.usage.inputTokens}/out=${event.usage.outputTokens} tok ≈ $${event.estimatedCostUsd.toFixed(6)})`,
        );
        break;
      case 'log':
        console.log(`[bus] log: ${event.message}`);
        break;
      default:
        break; // 演示只节选关键事件（全量事件的使用见 w14 可观测层）
    }
  }
}

/** 里程碑事件判定（过滤器：只看低频、有审计价值的事件——流式/计量类不进来） */
function isLifecycleEvent(type: HarnessEvent['type']): boolean {
  switch (type) {
    case 'session_created':
    case 'session_state_change':
    case 'message_persisted':
    case 'checkpoint_saved':
    case 'session_resumed':
    case 'memory_retrieved':
    case 'memory_written':
    case 'command_invoked':
    case 'command_finished':
    case 'skill_started':
    case 'skill_finished':
    case 'subagent_started':
    case 'subagent_finished':
      return true;
    default:
      return false;
  }
}

/** 长 id（uuid）截断显示 */
function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

/** 分幕标题横幅 */
function banner(title: string): void {
  console.log('');
  console.log('════════════════════════════════════════════════');
  console.log(`  ${title}`);
  console.log('════════════════════════════════════════════════');
}

await main();