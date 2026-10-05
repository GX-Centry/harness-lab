# 03 · 模块导览与学习路线

> 本文回答三个问题：**每个模块是干什么的**（导览）、**先读什么后读什么**（路线）、
> **学到什么程度算掌握**（每个模块末尾的「必答问题」，用来准备后续的互相质询）。
> 前置阅读：`01-architecture.md`（先建立全局形状），本篇是它的展开地图。

---

## 0. 三条使用建议

1. **不要按目录字母顺序读，按数据流顺序读**。一次 query 的数据流（01-architecture §3）
   就是最好的目录：命令拦截 → 会话 → 上下文组装 → 模型 → 工具调度 → 回写 → 持久化。
2. **每个模块先读它的 `types` 和接口注释，再读实现**。本项目约定：
   接口文件（如 `src/types.ts`）的注释密度最高，实现文件的注释解释「为什么」。
3. **每个模块末尾有一组「必答问题」**。如果你不能不看源码回答它们，
   说明还没吃透——这正是后续质询（grill）的题目来源。

---

## 1. 模块导览总表

> 「层」对应 zero2Agent final-project 的十层 Harness 心智模型；「状态」指当前实现进度。
> 状态更新于 w19 收官时（w01-w19 全部任务已完成，M0-M7 全部达成；端到端证据：
> `pnpm install --frozen-lockfile` 锁文件一致 + `pnpm lab` 九幕冒烟 + `pnpm test` 351 用例全绿 +
> `pnpm scenarios` 12 场景全过——新机器按仓库根 `README.md` 可跑通）。

| 模块 | 层 | 状态 | 一句话定位 | 关键文件 |
|---|---|---|---|---|
| 公共层 | 地基 | ✅ 已实现 | 全局类型 / 配置 / 错误分类 / 事件定义 | `src/types.ts` `src/config.ts` `src/errors.ts` |
| LLM | Query Engine | ✅ 已实现 | Provider 抽象 + Fake + 流式组装状态机 | `src/llm/*` |
| Tools | Tools | ✅ 已实现 | 工具协议 + 注册表 + schema 校验 | `src/tools/*` |
| Kernel | 内核 | ✅ 已实现 | Agent Loop / Dispatcher / EventBus | `src/kernel/*` |
| Hooks | Hook | ✅ 已实现 | 横切关注点管道（5 种 outcome） | `src/hooks/*` |
| Permission | Permission | ✅ 已实现 | 风险分级 + 规则匹配 + 确认 + 审计 | `src/permission/*` |
| Context | Context | ✅ 已实现 | 分层预算 + 多级压缩 + prompt 组装 | `src/context/*` |
| Session | Session | ✅ 已实现 | 状态机 + 持久化 + 检查点恢复 | `src/session/*` |
| Memory | Memory | ✅ 已实现 | 长期记忆：存储 / 检索 / 写入白名单 | `src/memory/*` |
| Commands | Command | ✅ 已实现 | 斜杠命令（进 LLM 之前拦截） | `src/commands/*` |
| Skills | Skills | ✅ 已实现 | 确定性编排（N 个工具串成能力包） | `src/skills/*` |
| Sub-agent | Sub-agent | ✅ 已实现 | Agent-as-Tool + 并发池 + fan-out 编排 | `src/subagent/*` |
| Observability | 横切 | ✅ 已实现 | 事件追踪（环形缓冲）+ 四维成本账本 | `src/observability/*` |
| Eval | 横切 | ✅ 已实现 | 评估闭环：场景即数据 + 行为断言 + 双 Rig（Core/Session）+ CI 退出码锚定 | `src/eval/*` |
| LangGraph 对照 | 对照层 | ✅ 已实现 | 框架重表达同一 Loop（StateGraph + LoopResult 契约对齐 + 对照笔记） | `src/adapters/langgraph/*` `docs/04-langgraph-comparison.md` |
| 预留模块 | P2 | ✅ 接口保留 | MCP / Web-SSE / STT / Teams（ADR-010：零实现，可整体删除） | `src/placeholders/*` |
| CLI | 组装 | ✅ 已实现 | 产品装配：芯（handleLine）/ 壳（REPL）/ 演示规则 Provider | `src/cli/*` |
| 演示场景 | 场景层 | ✅ 已实现 | 内核之外的场景注入示例 | `scenarios/*`（完整场景集：权限 / hook / 子代理 / 会话四域 8 场景——`pnpm scenarios`；lab 九幕在 `scripts/lab.ts`） |
| 测试套件 | 质量 | ✅ 已实现 | unit / integration / scenarios 三层 | `tests/*`（351 用例全绿；scenarios 层 = `tests/scenarios/full-set.test.ts` 锚定 12 场景全过） |

---

## 2. 模块详解（读代码时的关注点）

### 2.1 公共层 `src/types.ts` `src/config.ts` `src/errors.ts`

- **角色**：所有模块共享的「词汇表」。消息、流式事件、ToolResult、风险级别、错误码都在这里定义一次。
- **核心概念**：
  -「规范形消息」：Provider 差异（OpenAI vs Anthropic）全部收敛在 `llm/` 的适配层，
    其余模块只认规范形（ADR-003）；
  -「错误即数据」：`ToolResult` 的 ok/error 形状在类型层面就强制工具作者处理失败（ADR-004）；
  -「显式默认值」：`config.ts` 里每个配置项都有默认值 + 注释说明调大/调小的代价（如 16k 预算，ADR-007）。
- **必答问题**：
  1. 为什么 `StreamEvent` 用 Union 而不是一个宽松对象？（提示：穷尽检查 / 状态机）
  2. `errors.ts` 的错误分类中，哪些是「可重试」的，重试策略放在哪一层？

### 2.2 LLM 层 `src/llm/`

- **关键文件**：`src/types.ts` 的 `LLMProvider`（接口）、`fake-provider.ts`（确定性假模型）、
  `stream-assembler.ts`（流式组装状态机）、`openai-compatible-provider.ts`（真实适配）、`real-provider.ts`（环境变量解析）、`anthropic-provider.ts`（协议对照，预留）。
- **核心概念**：
  - Provider 是「唯一允许接触外部网络」的模块，其余一切可离线测试；
  - **流式组装状态机**（ADR-008）：`text_delta` 即到即显；tool_call 分片按 id 累积、结束时整体 parse。
    「截断的 tool_call」是确定性错误，必须可测试；
  - `countTokens` 是预算的计量基础，FakeProvider 用近似计数（如 `长度/4`），真实 Provider 可接官方计数器。
- **必答问题**：
  1. 如果流到一半连接断开，状态机应该产生什么？谁负责重试？
  2. 为什么 FakeProvider 不是「mock」而是「一等公民」？（提示：确定性优先铁律）

### 2.3 工具层 `src/tools/`

- **关键文件**：`src/types.ts`（Tool 协议）、`registry.ts`（注册与查找）、`validation.ts`（schema 校验）、`builtin/`（演示工具：calculator / fs-read / echo 等）。
- **核心概念**：
  - `inputSchema`（zod）一物三用：运行前校验、生成模型的工具描述、测试夹具；
  - `risk` 字段不参与执行，只被 Permission 消费——关注点分离；
  - Registry 是纯数据结构，不做执行；执行只发生在 Dispatcher。
- **必答问题**：
  1. 工具参数校验失败时，错误应该由 Dispatcher 还是工具自己产生？（提示：schema 校验在两者之间的哪个位置）
  2. 为什么 Registry 不直接暴露「执行」方法？（提示：四步执行链必须唯一入口）

### 2.4 内核 `src/kernel/`

- **关键文件**：`agent-loop.ts`（循环）、`dispatcher.ts`（单次工具调用四步链）、`events.ts`（EventBus）。
- **核心概念**：
  - **Agent Loop 的终止条件**有四类：模型自然结束（无 tool_calls）、预算耗尽、轮次上限、用户中断。
    每一类都要走「正常终结路径」（持久化 → 状态迁移 → 事件上报），不是 `break` 一走了之；
  - **Dispatcher 四步链**：pre-hooks → permission → execute → post-hooks。
    这是全项目最核心的 40 行代码——所有横切关注点都挂在这四个位置上；
  - EventBus 是「只读广播」：任何模块可 emit/订阅，但事件不参与控制流（控制流靠返回值）。
- **必答问题**：
  1. Loop 里「执行多个工具调用」是串行还是并行？选择理由与风险？
     （提示：对照 ADR 与 subagent 并发池的区别）
  2. Dispatcher 中 hook 返回 `modify_input` 后，权限检查用的是旧参数还是新参数？为什么？

### 2.5 Hook 层 `src/hooks/`

- **关键文件**：`src/types.ts`（Hook 协议：5 种 outcome）、`pipeline.ts`（管道执行器）、`builtin/`（audit 审计 / truncate-result 结果截断 / redact-result 脱敏 / repeat-guard 重复熔断）。
- **核心概念**：
  - 5 种 outcome（continue / modify_input / modify_result / block / skip）是管道的灵魂，
    它决定了「横切逻辑能在不改主流程的前提下做多少事」；
  - priority 数字小者先执行；`skip` 用于「已拦截，后续不必再看」；
  - hook 自身报错不阻断主流程（ADR-009），错误进事件流。
- **必答问题**：
  1. `modify_input` 和 `block` 能否在同一次管道执行中先后出现？语义上谁说了算？
  2. 「重复调用熔断」为什么用 hook 实现而不是写进 Loop 里？（提示：可拔插 / 可关闭）

### 2.6 权限层 `src/permission/`

- **关键文件**：`gate.ts`（决策入口 + `ConfirmHandler` 确认抽象契约）、`rules.ts`（规则匹配）。
- **核心概念**：
  - 决策三态：allow / confirm / deny；confirm 在 CLI 是询问，在未来的 Web 形态是异步等待
    ——所以 `confirm` 必须抽象成接口（为预留模块铺路）；
  - 拒绝不是异常，而是一条**工具结果**（ADR-005）：模型看到 `permission_denied` 后可以换路。
- **必答问题**：
  1. deny 之后模型再次请求同一操作，谁负责防止死循环？（提示：与 hooks 的关系）
  2. 规则匹配的默认策略是什么（默认 allow 还是默认 confirm）？为什么？

### 2.7 上下文层 `src/context/`

- **关键文件**：`manager.ts`（组装）、`tokens.ts`（计量与预算基础）、`compressor.ts`（多级压缩）。
- **核心概念**：
  - 五层信息结构：system / profile / task / history / recent，各层有独立预算；
  - 压缩是分级降级链：先丢可再生的（工具输出详情），再截断历史，最后才摘要；
  - 预算检查发生在**两处**：组装时（超了就压）和工具结果写回时（超限先压再写）。
- **必答问题**：
  1. 为什么 `history` 和 `recent` 要分两层，而不是一个大数组？（提示：注意力与压缩策略的差异）
  2. 单条工具结果超过单层预算时怎么处理？给出降级顺序。

### 2.8 会话层 `src/session/`

- **关键文件**：`session-manager.ts`（状态机 + 编排）、`store.ts`（SQLite 持久化）、`checkpoint.ts`（检查点）。
- **核心概念**：
  - 状态机：created → processing → completed / failed / interrupted；
  - 检查点是「恢复的最小充分信息」：消息历史 + 循环轮次 + 待执行工具调用；
  - 恢复语义：进程崩溃后从最近检查点继续，不重放已完成工具（幂等靠 checkpoint 记录）。
- **必答问题**：
  1. checkpoint 频率与性能的权衡点在哪？（待决清单第 1 条）
  2. 若工具执行完成但结果尚未落盘就崩溃，恢复后会发生什么？这是可接受的吗？

### 2.9 记忆层 `src/memory/`

- **关键文件**：`store.ts`（存储）、`retriever.ts`（检索）、`trigger.ts`（写入白名单）。
- **核心概念**：
  - 三层记忆：会话内（session 天然持有）/ 跨会话事实（facts）/ 偏好（preferences）；
  - **写入白名单**：不是所有对话都值得记——触发条件（用户显式要求、任务完成后的结论等）是核心设计点；
  - 检索先用朴素词频（FakeProvider 下保持离线可测），embedding 是升级路径（待决清单第 3 条）。
- **必答问题**：
  1. 记忆检索结果注入上下文的哪一层？注入失败的降级行为是什么？
  2. 「该记什么」的判断在 trigger 还是模型？各有什么代价？

### 2.10 命令层 `src/commands/`

- **关键文件**：`parser.ts`（拦截判断）、`builtin/`（/status /history /compact /help 等）。
- **核心概念**：命令在「进 LLM 之前」处理，是 REPL 的控制面；命令实现可以调用内核模块
  （如 `/compact` 调 compressor），但内核**不能**反向依赖命令。
- **必答问题**：为什么命令不做成「模型可调用的工具」？（提示：控制面 vs 数据面）

### 2.11 技能层 `src/skills/`

- **关键文件**：`types.ts`（协议）、`registry.ts`（注册）、`runner.ts`（确定性执行器）。
- **核心概念**：Skill = 把 N 个工具调用（或命令）按固定顺序串成「能力包」，
  中间不经过模型——这是「确定性编排」；与 Agent Loop 的「模型自由编排」形成对照。
- **必答问题**：什么任务适合 Skill 而非让模型自由调用工具？（给出判断标准）

### 2.12 子代理层 `src/subagent/`

- **关键文件**：`types.ts`（协议：隔离四层 / 单轨分账 / 两只错误码）、`agent-tool.ts`（Agent-as-Tool 编译与五路结果映射）、`pool.ts`（并发池：partial 结算与 AbortError 分类）、`orchestrator.ts`（fan-out 编排 + `spawn_subagents` 工具）。
- **核心概念**：
  - 「Agent-as-Tool」：子代理对父代理而言就是普通工具（输入=任务描述，输出=结果摘要），
    这样 Sub-agent 不需要改动内核 Loop；
  - 与 Loop 内串行工具调用不同，这里做并发池（受限并发 + 超时 + 部分失败聚合）。
- **必答问题**：
  1. 子代理的上下文与父代理如何隔离？token 成本怎么归属？（提示：observability 的归属维度）
  2. 并发池里一个子代理失败，编排的默认语义是什么（fail-fast 还是 partial）？为什么？

### 2.13 横切：可观测 `src/observability/` 与 Eval `src/eval/`

- **核心概念**：
  - Tracer/Cost 是 EventBus 的消费者，**不是** 中间件——不参与控制流；
  - 成本归属维度：session / query / subagent / model（「tool 维度」由 subagent
    承接——普通工具不产生 LLM 调用，见 `cost.ts` 决策 ②）；
  - Eval 的哲学：断言「行为」而非「文本」——断言工具调用序列、终止原因、错误码，
    不精确匹配自然语言输出（否则测试脆弱）。
- **实现状态（w14 已完成）**：
  - 订阅链单向无环：`llm_response → 查定价表 → 落 CostEntry → 产出 usage_recorded`
    （定价权必须在成本域——`observability/types.ts` 必答问题 ③ 记录了 w04 草案
    注释的修正）；
  - 未定价模型「宁缺毋滥」：条目照记、不发布假价格、摘要记 `unpricedCalls`；
  - 子代理归因：从派生 queryId（`父q>agent`）解析末段——w13 的分账设计在账本层
    事后变现，内核零改动；
  - Tracer 环形缓冲（容量可配）+ 查询按 seq 排序（修复同步总线重入 emit 的乱序）；
  - Eval：场景即数据 + **双 Rig**（Core Rig「剥光外壳的内核装配」/ Session Rig
    「含会话层的完整装配」——两者共享 `assembleHarness`，差异恰好是会话层；
    与 lab 的 bootProcess 互为对照）+ 10 个断言 helper；失败收集非 fail-fast、
    断言 bug 不炸批次。
  - Eval（w18 扩展）：完整场景集 `scenarios/`（仓库根）——权限 / hook / 子代理 /
    会话四域 8 场景 + 内置基准 4 = 12；`pnpm scenarios` 一键运行，
    `reportExitCode` 锚定 CI 退出码（报告 → 进程契约的唯一换算点）。
- **必答问题**：为什么可观测层不允许拦截或修改事件？（事件流不可变的意义）

### 2.14 对照层 `src/adapters/langgraph/`

- **核心概念**：用 LangGraph 的 StateGraph 重表达「上下文组装 → 模型 → 工具 → 回写」循环，
  输出一份《框架对照笔记》：哪些能力框架白送（状态持久化、流式事件、断点恢复），
  哪些被隐藏了（重试细节、消息裁剪、并发控制），换算成代码量是多少。
- **必答问题**：LangGraph 的 checkpoint 与我们的 checkpoint 语义差异是什么？
  （答案在 `docs/04-langgraph-comparison.md` §4：引擎的「进程快照」vs 会话的「业务存档」）
- **实现状态（w16 已完成）**：
  - 实验纪律——**唯一变量是控制流宿主**：同一 FakeProvider 脚本、同一 Dispatcher、
    同一 config，两个宿主跑同一场景逐字段对照（`tests/integration/langgraph-adapter.test.ts`）；
  - `graph.ts`：Annotation 状态（reducer 对照手工累加）+ model/tools 节点 + 条件边；
    max_turns 边界刻意对齐 while 循环的「轮头检查」语义（第 M 批工具已执行）；
  - `runner.ts`：与 AgentLoop **同契约**（同输入同 LoopResult）；取消路径实证
    「框架送 checkpoint 管道、协议补位自己写」（复用 `fillInterruptedToolResults`）；
  - 叶子原则：devDependency、不进 `src/index.ts` 主出口、可整体删除；
  - 实测锚点：双宿主等价（§1）、边界对齐（§2）、持久化粒度 1 次 vs 5 条（§3）、
    取消配对补位（§4）——四用例全绿。

### 2.15 预留模块 `src/placeholders/`

- **核心概念**：MCP / Web-SSE / STT / Agent Teams 的接口定义 + 接入点分析 + 冲突说明
  （ADR-010）。**不实现逻辑，只保留结构**——这是「演进路径的完整记录」。
- **必答问题**：这四个模块各自与「单进程 CLI」形态的冲突点是什么？解冻条件分别是什么？
  （答案在四个源文件的文件头注释：冲突分析 → 接入点 → 解冻条件，同一结构）
- **实现状态（w15 已完成）**：
  - 每模块以统一三段式保留：冲突（为什么暂缓）→ 未来接入点（解冻时接线点）→ 解冻条件；
  - 形状可对接性经测试证明：MCP → 工具注册面（命名空间 + 信任映射）、
    AsyncConfirmationBroker → `ConfirmHandler`（类型严格兼容，返回 Promise<boolean>）、
    STT 输出与 readline 同型、Teams 收件箱与黑板形状；
  - **零运行时资产**：四模块 + 出口编译后均为空模块（Object.keys 为空，测试锚定）——
    「可整体删除」不是口头声明。

### 2.16 组装层 `src/cli/`

- **关键文件**：`app.ts`（芯：`handleLine` 纯逻辑）、`render.ts`（渲染层）、
  `repl.ts`（壳：REPL 循环与确认通道）、`main.ts`（入口与参数解析）、
  `index.ts`（出口——`main.ts` 刻意不进，副作用入口边界）。
- **核心概念**：
  - 「芯 / 壳分离」：`handleLine(line, signal) → AsyncGenerator<CliOutput>` 不碰
    readline 与 stdout，壳只做「读一行 → 交给芯 → 交给渲染器」；单次模式与 REPL
    共用同一渲染路径；
  - 组装层是同一套模块的**第三种拼法**：lab 的 bootProcess（教学演示）/ eval 的
    Core Rig（剥光外壳）/ cli 的 `createCliApp`（产品）——Provider 替换点唯一
    （`options.provider`），演示与产品走同一条 Loop；
  - 会话就位：显式 id（存在即复用 / 不存在即创建）+ 状态门控恢复（仅
    interrupted/processing 走 `resumeSession`）+ `resumeReport` 回报补位结果。
- **必答问题**：
  1. `handleLine` 为什么设计成 AsyncGenerator 而不是普通 `async` 函数？
     （提示：对话输出是逐步产生的事件流，命令输出是单条结果——一个通道统一两类）
  2. 确认通道的超时与 readline `question` 不同步会发生什么？
     （答案：悬挂的 `_questionCallback` 会无声吞掉用户下一次输入，见 `repl.ts`
     的同源超时 + 哨兵注入自清理）
- **实现状态（w17 已完成）**：
  - 五文件全部完成，`CliOutput` 判别联合（command / loop）是壳与芯之间的全部词汇；
    19 个集成用例（`tests/integration/cli.test.ts`）逐层锚定：芯 4 例 / 组装 3 例 /
    渲染 5 例 / 演示规则 5 例 / 确认通道 2 例；
  - readline 三个深水区实证并固化：管道 stdin 被空闲 readline 提前消费（-p 模式不预建）、
    race 超时后悬挂回调吞输入（哨兵注入自触发清理）、for-await 迭代中 question 安全；
  - 确认通道三态：`--yes` 自动批准 > `stdin.isTTY`（readline 问答）> 非交互 fail-safe 拒绝；
  - `dispose` 必须同时关闭 SessionStore 与 MemoryStore 两个 SQLite 连接
    （漏关会让文件锁残留，Windows 上删除/重开 EPERM——测试真实踩过）；
  - lab 幕 I 演示 CLI 形态：工具闭环 / 子代理+确认 / 斜杠命令 / 会话落盘证明。

---

## 3. 第一个端到端的实现顺序（(1)→(7)）

对齐 01-architecture §3 数据流图中的编号，也对应下面的里程碑 M1-M4：

```text
(1) 输入进入：CLI REPL 最简版（while readline → 交给 kernel）
(2) 上下文组装：ContextManager.build()（初期只做拼接，预算/压缩后补）
(3) 模型调用：Provider.stream() + StreamAssembler
(4) tool_calls 判断：Loop 分支
(5) 工具执行：Dispatcher 四步链（Permission/Hook 先放空实现）
(6) 结果回写：写回消息历史（压缩后补）
(7) 循环控制：预算/轮次检查 → 回 (2) 或终结
```

**关键原则：每一步都可运行。** 不做「全写完再联调」——
M1 结束时能纯对话，M2 结束时能调工具，之后逐步把空实现替换成真实现。

---

## 4. 里程碑路线（w 编号 → 任务对照）

> w01-w19 已完成（环境核查 / 工程配置 / 设计文档 / 内核与扩展 / 可观测与评测 / 对照与预留 / CLI 组装 / 完整场景集 / README 与学习文档收尾）；M0-M7 全部达成，逐模块进度见 §1 总表。

| 里程碑 | 任务 | 交付物 | 可验证标准 |
|---|---|---|---|
| M0 公共层 | w04 | types / config / errors / events | `tsc --noEmit` 通过 |
| M1 纯对话 | w05 + w17(最小骨架) | Provider + Fake + 组装状态机 + 最简 REPL | FakeProvider 下 `chat` 能完成一轮问答 |
| M2 工具闭环 | w06 + w07 + w08 | Tool 协议 + 四步链 + Agent Loop | FakeProvider 脚本「调 calculator」端到端跑通 |
| M3 工程化 | w09 + w10 + w14(部分) | Context + Session + 事件追踪 | 长对话不爆预算；重启可恢复会话 |
| M4 P1 能力 | w11 + w12 + w13 | Memory + Skill/Command + Sub-agent | 跨会话记忆生效；/命令可用；子代理并发 |
| M5 质量闭环 | w14 + w18 | Eval + 三层测试套件 | `pnpm test` 全绿；场景断言通过 |
| M6 对照与预留 | w15 + w16 | placeholders + LangGraph 对照层 | 对照笔记成文；内核不依赖对照层（可删） |
| M7 组装与文档 | w17(完整) + w19 | 完整 CLI + README + 学习文档 | 新机器克隆后按 README 可跑通演示 |

依赖关系注意：**w08 (Loop) 依赖 w07 (Dispatcher) 提供空实现即可开工**，
不要等 Permission/Hook 完整——这就是「可运行优先」的工程习惯。

---

## 5. 三层测试策略

```text
tests/
├── unit/          纯函数与状态机：stream-assembler / context / permission / hooks / retry
│                  → 无 IO、无时钟、无网络；失败即定位
├── integration/   模块组装：agent-loop / dispatcher 四步链 / session+store / memory
│                  → 用 FakeProvider + 临时 SQLite（tmp 目录，测后删除）
└── scenarios/     端到端确定性场景：锚定仓库根 `scenarios/` 的完整场景集
                   → 对齐 agent-api-lab 方法论（FakeProvider + 固定脚本 + 场景断言）
                   → 12 场景四域：内置基准 / 权限 / hook / 子代理 / 会话（双 Rig）
```

**场景测试的写法约定**（对齐 01 §0 铁律 2）：

- 每个场景 = 一个固定输入脚本 + 一组「行为断言」（工具调用序列 / 终止原因 / 错误码 / 事件序列）；
- 断言**行为**而非文本：`expect(result.toolCalls).toEqual(['calculator'])`，
  而不是 `expect(answerText).toContain('9')`（后者脆弱且无信息量）——
  唯一例外是「Harness 契约文本」（如恢复补位的占位说明）：那是框架产物，可断言；
- 场景即数据：新场景 = 一个 `EvalScenario` 纯数据对象 + 断言函数（照抄 `scenarios/`
  任一文件即可）；`pnpm scenarios` 跑全量 12 场景、`reportExitCode` 锚定 CI 退出码；
- 双 Rig 数据驱动：声明 `session` 预置的场景自动走 Session Rig（真 SQLite
  跨进程恢复），其余走纯内存 Core Rig——场景不需要知道 rig 的存在；
- 每个 ADR 中的关键决策至少有一个测试锚定它（如 ADR-005 的「拒绝注入上下文」，
  w18 追加「hook block 转拒绝」「崩溃补位配对完整」两个锚点）。

---

## 6. 建议学习路线（给别人讲得清楚的顺序）

> 入口：先按仓库根 `README.md` 的「快速开始」跑通四步（install / test / lab / scenarios），
> 拿到全部实证输出后，再进入下面的五遍推进。

```text
第一遍（跑通）：按 M1 → M2 动手复现一次，重点是 (1)-(7) 数据流
第二遍（深读）：kernel/dispatcher.ts 的四步链 → hooks/pipeline.ts 的 outcome 语义
第三遍（工程）：context 压缩降级链 → session checkpoint 恢复语义
第四遍（拓展）：memory 触发白名单 → subagent 并发与成本归属
第五遍（对照）：用 LangGraph 重写 Loop，写《框架对照笔记》
```

每遍结束后，用各模块的「必答问题」自测；答不上来的模块重读其接口注释——
这正是设计时把注释密度压在接口文件的原因。

---

## 7. 冲突与预留清单（为什么有些代码是被注释的）

| 模块 | 冲突点 | 当前处理 | 解冻条件 |
|---|---|---|---|
| MCP | 长驻连接管理 + 新权限语义 | 接口保留（placeholders/mcp.ts） | 内核权限模型支持「外部工具源」后 |
| Web/SSE | 交互模型从阻塞 REPL 变为多客户端事件流 | 接口保留（placeholders/web-sse.ts） | Confirm 异步化 + EventBus 支持订阅者协议 |
| STT 语音 | 音频管线超出内核范围 | 接口保留（placeholders/stt.ts） | CLI 形态稳定后，作为独立输入源接入 |
| Agent Teams | 多代理调度器与「单 Loop 可讲解」冲突 | 接口保留（placeholders/teams.ts） | subagent 并发池经真实场景验证后 |

原则（ADR-010）：**注释保留、结构不删**——将来解冻时，接口与冲突分析已经在位。

---

*下一篇：`04-langgraph-comparison.md`（LangGraph 对照笔记——同一循环的框架重表达与代价记录）。*
*返回：`01-architecture.md` 总览 · `02-design-decisions.md` 取舍原因 · `00-environment.md` 环境避坑。*
