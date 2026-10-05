# 02 · 设计决策记录（ADR）

> 本文用 ADR（Architecture Decision Record）格式记录每个关键取舍。
> 格式约定：**背景 → 决策 → 代价与被否决的选项**。
> 当你想推翻某个设计时，先读完对应 ADR 的「代价」段——它写明当时的权衡。
> 后续每引入一个重大设计变更，**追加**一条 ADR（不要改写历史条目）。

---

## ADR-001 · 实现语言：TypeScript + Node.js 26

- **状态**：已采纳
- **背景**：候选为 TS/Node、Python、双语言。用户既有 Python 项目（jobpilot/MediaCrawler），
  但 zero2Agent 教程主线（Claude Code / Codex / pi / DeepSeek Harness 拆解、
  final-project/OfferPilot）全部为 TS 生态。
- **决策**：TypeScript + Node.js 26 + pnpm 11。类型系统承担「接口即文档」的职责，
  与教程材料可以互相逐行印证。
- **代价**：Python 的 AI 生态（transformers 等）不可直接复用；
  但本项目核心是 Harness 工程（协议/状态管理/编排），不涉及模型训练。

## ADR-002 · 核心全手写，LangGraph 仅作对照层

- **状态**：已采纳
- **背景**：「允许依赖任何现成 Agent 框架」与「核心工程层尽量全部自行手写」并存。
- **决策**：`src/` 内核零 Agent 框架依赖（仅 zod 做 schema 校验、node:sqlite 做存储）；
  LangGraph 只在 `src/adapters/langgraph/` 出现，用一个「同一任务的 Loop」做对照实现，
  回答「框架替我们做了什么、代价是什么」。（用户明确选择了此方案）
- **代价**：对照层引入较重的依赖树（langchain 系），因此它被隔离为叶子模块，
  可以整体删除而不影响内核；文档中标注了「哪些能力框架白送、哪些隐藏起来了」。

## ADR-003 · 内部统一「规范形」消息模型 + Provider 适配层

- **状态**：已采纳
- **背景**：OpenAI 格式（`tool_calls` 数组 + `role:tool` 消息）与 Anthropic 格式
  （content blocks + `tool_result` block）差异显著。直接透传 provider 格式会导致：
  ① 上层（Context/压缩/记忆）要写两套逻辑；② 换模型等于重写 Harness。
- **决策**：内部一律使用规范形 `Message`（见 01-architecture §5.1），
  适配差异全部收敛在 `src/llm/*-provider.ts` + `stream-assembler.ts`。
- **代价**：多一层映射代码，且需要持续跟进两家 API 演进；
  收益是「Harness 与模型解耦」——这正是 Query Engine 层存在的意义。

## ADR-004 · Tool.execute 永不抛异常，错误即数据

- **状态**：已采纳（对齐 final-project 的工具协议）
- **背景**：工具失败（参数错、超时、服务错）在 Agent 场景中是**常态**，
  且模型需要看到失败原因才能自我修正。
- **决策**：`execute` 一律返回 `ToolResult { ok, content, error? }`；
  错误码限定为 `input_error | service_error | timeout | permission_denied | internal_error`。
  框架层兜底 try/catch，任何漏网的异常都会被包装为 `internal_error` 结果。
- **代价**：工具作者不能靠抛异常短路，需要显式构造错误；换来的是
  「错误永远可被模型感知、可被 hook 审计、可被测试断言」。

## ADR-005 · 权限拒绝 → 注入模型上下文，而非终止循环

- **状态**：已采纳
- **背景**：朴素实现里，权限拒绝常直接 throw 或终止会话。
- **决策**：拒绝被表达为一条**工具结果**（`permission_denied` 错误码）返回给模型，
  Agent 可以改用其他方式完成任务；同时会话状态记为正常、审计留痕。
- **代价**：模型可能反复尝试被拒操作（由「重复调用熔断」hook 兜底，
  对齐 agent-api-lab 的 `repeat` 场景）；换来的是「权限是对话的一部分」这一正确语义。

## ADR-006 · 存储用 Node 内置 `node:sqlite`，不用 better-sqlite3

- **状态**：已采纳
- **背景**：Session/Memory/审计需要持久化。better-sqlite3 是原生扩展（node-gyp/预编译二进制），
  在 Node 26 新版本上存在预编译包缺失风险；而 Node 22.5+ 起内置 `node:sqlite`（DatabaseSync）。
- **决策**：用 `node:sqlite`。零原生依赖、零安装成本，教学项目优先「开箱即跑」。
- **代价**：API 比 better-sqlite3 略简（无扩展生态）；若未来需要 FTS5/向量扩展，
  评估 `node:sqlite` 的 loadExtension 能力后再定（FTS5 通常已随内置编译）。

## ADR-007 · 上下文默认预算 16k tokens，而非吃满模型窗口

- **状态**：已采纳（对齐 final-project 的 Context 设计）
- **背景**：现代模型窗口 128k–200k+，直觉上「能塞多少塞多少」。
- **决策**：默认 `maxTotalTokens: 16000`（5 层分层预算 + 预留 4000 输出），
  超出走多级压缩。理由：**成本与注意力稀释**——16k 精打细算的上下文通常优于
  100k 稀释的上下文；且预算是可测试的硬约束。
- **代价**：需要维护压缩链路（截断 → 摘要）；复杂长任务可能需要提高预算。
  预算值集中在 `src/config.ts`，推翻成本极低。

## ADR-008 · 流式组装必须是显式状态机

- **状态**：已采纳（对齐 agent-api-lab 的 StreamAssembler）
- **背景**：流式下 `tool_calls` 的参数是分片到达的（`tool_call_delta`），
  而执行工具必须等**完整 JSON**；文本 delta 却可以即到即显。
  混在一起处理会产生「半个 JSON 去 parse」这类经典 bug。
- **决策**：`stream-assembler.ts` 实现显式状态机：
  文本增量直接上报事件；tool_call 按 id 累积，`tool_call_end` 时整体 parse 并校验。
  对「截断的 tool_call」（流结束但 JSON 不完整）产生的是一类**可测试的确定性错误**。
- **代价**：多一个需要重点测试的状态机模块（tests/unit 已覆盖），
  换来协议层稳定——这是最高频的 Agent bug 来源之一。

## ADR-009 · Hook 自身报错不阻断主流程

- **状态**：已采纳
- **背景**：Hook 是横切关注点（审计/压缩/指标）。如果某个 hook 抛异常就中断整个 Agent，
  等于把「可观测性组件」变成了可用性单点。
- **决策**：HookPipeline 对每个 hook 单独 try/catch；
  hook 失败记录到事件流（`hook_error`）并继续执行后续 hook / 主流程。
  除非 hook 显式返回 `block`。
- **代价**：hook 的 bug 不会立刻炸出来，需要靠事件流与测试发现——
  用 `observability` 的 `hook_error` 事件平衡。

## ADR-010 · 冲突/未成立模块：接口保留 + 注释，不删结构

- **状态**：已采纳（用户需求原文：「即使冲突也注释保留结构」）
- **背景**：MCP 集成、Web/SSE、多模态 STT、Agent Teams 等模块，
  与当前「单进程 CLI + 单 Agent Loop」形态存在真实冲突：
  - MCP：需要长驻的连接管理与额外的权限语义；
  - Web/SSE：交互模型从「阻塞式 REPL」变为「多客户端事件流」，Permission 确认需要异步化；
  - STT：引入音频管线与文件上传，超出内核范围；
  - Agent Teams：多代理 + 消息总线会把 Loop 从单循环扩展为调度器，与 P0 的「可讲解」冲突。
- **决策**：在 `src/placeholders/` 下为每个模块保留**接口定义 + 设计要点注释 + 接入点说明**，
  不实现逻辑；对应 ADR 标注「暂缓」及解冻条件。
- **代价**：目录中存在「死代码」；换来的是演进路径的完整记录——
  将来任何一项解冻时，接口与冲突分析已经在位。

## ADR-011 · 环境工程约定（代理 / allowBuilds / 编码）

- **状态**：已采纳
- **背景**：见 `00-environment.md` 的实测结论：npm 直连被证书干扰、PS 5.1 重定向写 UTF-16、
  控制台 GBK 等。
- **决策**：
  1. pnpm/git 全局固定代理 `127.0.0.1:7890`（已写入用户级配置）；
  2. pnpm 11 的依赖构建脚本走 `pnpm-workspace.yaml` 的 `allowBuilds` 白名单（当前仅 esbuild）；
  3. 全仓库 UTF-8 无 BOM + LF；文件写入一律走 IDE/Node，不用 PS 重定向。
- **代价**：换机/换代理时需要同步这几处配置（已记录在 00-environment.md 的检查清单）。

## ADR-012 · `erasableSyntaxOnly` + `.ts` 扩展名导入（Node 原生可跑）

- **状态**：已采纳
- **背景**：实测 Node 26 可直接 `node xxx.ts`（type-stripping）。条件是：
  ① 只用可擦除 TS 语法（禁 enum/namespace/参数属性）；② 相对导入显式带 `.ts` 扩展名。
- **决策**：tsconfig 开启 `erasableSyntaxOnly` + `allowImportingTsExtensions` +
  `rewriteRelativeImportExtensions`；全仓库 `import './x.ts'`。
  开发期 tsx 与 node 原生双轨均可用（scripts 默认 tsx，生态成熟）。
- **代价**：不能用 enum（用 `as const` 对象代替，同样类型安全）；
  导入路径带 `.ts` 初见略怪——换来零转译依赖与最接近运行时的调试体验。

---

## 待决清单（w19 收官——全部已决）

> w03 设计时登记的四个未定项，留到实现时决策。**原始问题陈述不改写**，
> 结论以「→ 已决」追加——这本身就是一条完整的「设计 → 落地」教学线索。

1. **checkpoint 粒度**：按「每 N 轮」还是「每次工具调用后」？（等 Session 模块实现时 benchmark）
   → **已决：`every_turn`（轮次边界）为默认**。只有配对完整的轮次边界快照才进存储
   （`session-manager.ts` 纪律③）；`after_tool` 因 Loop 尚无逐工具回调接缝，
   **显式降级并警告**（不静默忽略）；`manual` 留给显式调用场景。演进点 =
   Loop 增加 `onToolExecuted` 回调（`session-manager.ts` w10 注释）。
2. **压缩用的摘要由谁生成**：模型生成（贵、准）vs 启发式截断（免费、糙）？
   倾向：Level 1 启发式、Level 2 模型摘要，可配置。
   → **已决：v1 全链路确定性规则**（L1 截断 → L2 丢弃 → L3 规则摘要折叠 → L4 摘要截断，
   见 `compressor.ts` 文件头）。规则摘要同输入同输出、可测试零依赖；LLM 摘要是
   明确演进点——替换一个函数即可，调用面不变。
3. **Memory 检索的相似度实现**：朴素词频 vs embedding？（FakeProvider 下先用词频，保持离线可测）
   → **已决：朴素词频（v1）**。embedding 是升级路径：替换打分函数、管线不变
   （`retriever.ts` 文件头已隔离接口；配置面见 `config.ts` 记忆域）。
4. **LangGraph 对照层覆盖度**：只对照主 Loop，还是包含条件边/中断恢复？（先做 Loop + tool 节点）
   → **已决：主 Loop 全维度对照**——StateGraph 重表达 + `max_turns` 边界语义对齐 +
   取消路径（复用补位协议 `fillInterruptedToolResults`）+ 持久化粒度对照；全部有测试
   实证（`docs/04-langgraph-comparison.md` §1–§4）。

*下一篇：`03-module-guide.md` —— 模块导览与学习路线。*
