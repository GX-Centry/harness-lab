# harness-lab

> 从零手写的**教学级 Agent Harness 框架**：Agent Loop / Tool Dispatch / Context /
> Permission / Session / Hook 全栈实现，附 LangGraph 对照适配层。
> 核心工程层**零 Agent 框架依赖**（仅 zod 做 schema 校验、`node:sqlite` 做存储）。
> **代码即教程**：每个模块的注释回答「这一环扮演什么角色」「数据怎么流」
> 「为什么这样设计、代价是什么」。

本项目的十层模块心智模型源自 zero2Agent 教程的 final-project（OfferPilot），
并重写为一套**可独立运行、可测试、可评测**的实现——读完它，你应该能回答：
**一个 Agent 框架到底由哪些部件组成，每一环的代价是什么。**

---

## English TL;DR

**harness-lab** is a from-scratch, teaching-grade **LLM Agent Harness** framework in
TypeScript — Agent Loop / Tool Dispatch / Context / Permission / Session / Hooks all
hand-written, plus a LangGraph comparison layer. The core has **zero agent-framework
dependencies** (only `zod` for schemas and built-in `node:sqlite` for storage).

*Code is the tutorial*: every module explains its role, data flow, design rationale
and cost. Everything runs **offline** via fake providers — no API key required.

```bash
pnpm install && pnpm test && pnpm lab && pnpm scenarios
```

---

## 这是什么（30 秒版）

- **前提判断**：Agent 的主战场不在模型，在 Harness。
- **三条铁律**（全文见 `docs/01-architecture.md` §0）：
  1. **核心手写、框架对照**——Loop / Dispatch / Context / Permission / Session / Hook
     全部从零实现（这是学习对象本身）；LangGraph 只出现在对照层，回答
     「同样的循环用框架表达是什么样、代价是什么」。
  2. **确定性优先**——一切外部依赖（LLM / 时钟 / 随机数）可替换；FakeProvider
     打底，全部测试与演示**离线可跑、零 API Key**。
  3. **代码即教程**——冲突/暂不成立的模块「注释保留、结构不删」（ADR-010），
     演进路径完整留档。
- **交付形态**：三层测试套件（unit / integration / scenarios）+ 九幕端到端演示
  （`pnpm lab`）+ 12 场景评估集（`pnpm scenarios`，带 CI 退出码语义）。

---

## 快速开始（四步跑通）

**环境要求**（实测版本见 `docs/00-environment.md`）：

| 工具 | 版本 | 为什么 |
|---|---|---|
| Node.js | **≥ 26** | `node:sqlite` 内置稳定（ADR-006）+ 原生 type-stripping（ADR-012） |
| pnpm | 11 | 首选包管理器（用 npm 时等价替换为 `npm run <script>`） |

在仓库根目录依次执行：

```bash
pnpm install     # 安装依赖（zod + typescript / tsx / vitest / @types/node / @langchain/langgraph）
pnpm test        # ① 三层测试套件：31 个文件 / 351 用例全绿（~9s）
pnpm lab         # ② 九幕端到端演示：A→I 全部路径 + 终幕读回（~秒级）
pnpm scenarios   # ③ 12 场景评估报告：行为断言 + CI 退出码（~100ms）
```

各步骤的预期关键输出：

```text
# pnpm test
 Test Files  31 passed (31)
      Tests  351 passed (351)

# pnpm lab（收官行）
✔ 全部幕次执行完毕——持久化 / 重启续问 / 优雅取消 / 崩溃补位 / 跨会话记忆 /
  命令与技能 / 子代理 / 可观测与评测 / CLI 组装 九条路径均已演示。

# pnpm scenarios
评测报告：12/12 通过——断言「行为」而非文本
  ✓ basic-tool-loop …
  ✓ permission-rule-allow …
  ✓ hook-block-repeat …
  ✓ session-resume-fill …   （共 12 行）
```

**CI 退出码语义**：`pnpm scenarios` 全过退出码 `0`、有失败退出码 `1`
（`reportExitCode` 是「评测报告 → 进程契约」的唯一换算点）；`pnpm test` /
`pnpm lab` 失败同样非零退出——三条命令都可直接进 CI。

> **网络说明**：若 `pnpm install` 因 registry 直连失败（证书干扰等），
> 切换镜像后重试：`pnpm config set registry https://registry.npmmirror.com`。
> 若中文显示乱码（GBK 控制台）：先执行 `chcp 65001`，或设置
> `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`。

### 可选：交互对话（CLI 形态）

```bash
pnpm chat                        # 交互式 REPL（/exit 退出 · Ctrl+C 取消当前对话）
pnpm chat -p "帮我算 12*(3+4)"    # 单次问答后退出（脚本友好）
pnpm chat --session demo         # 指定 / 复用会话（不存在则创建）
pnpm chat --continue             # 继续最近一次会话
pnpm chat --yes                  # 自动批准权限确认（无人值守 / 演示）
```

对话模式默认使用**规则驱动的确定性演示 Provider**（`src/cli/demo.ts`，离线、
零成本、可复现）——REPL 要展示的主体是会话 / 记忆 / 命令 / 子代理 / 权限这条
管道，而非模型的智能程度。要接**真实 OpenAI 兼容 API**（DeepSeek / OpenAI /
Ollama…）见下方「接入真实 LLM API」——换真实模型 = 换一个 `LLMProvider`
实现，替换点仍然只有一处。

### 可选：网页观测台（Web 形态）

```bash
pnpm web     # 启动网页控制台 → 浏览器打开 http://127.0.0.1:4173（Ctrl+C 退出）
```

同一套 `createCliApp` 装配的**第四条壳**（`scripts/web.ts` + `web/`）：交互面
从 readline 换成 HTTP + SSE，把双通道事件（HarnessEvent 诊断流 + LoopEvent
对话流）按到达顺序合并成一条 wire，浏览器端以「回放引擎」（cursor 纯函数重建）
呈现整条主链路——对照学习用：

- **六阶段**：输入 → 上下文组装 → 模型调用 → 工具分发四步链 → 结果回写 → 循环控制
- **七横切层**：权限 / Hook / 命令·技能 / 会话 / 记忆 / 子代理 / 可观测
- **播放控制**：实时跟随 / 单步（→）/ 变速播放 / 拖动回看 / 从头回放（R）/
  刷新页面自动重放整场运行
- **权限确认**：web 壳把 ConfirmHandler 桥到浏览器横幅（120s 超时自动拒绝）
- **服务设置**：顶栏热切换模型来源——预设服务商 / 自定义 URL / 连通测试
  （见下方「接入真实 LLM API」节）
- 数据写入 `data/web.db`（与 CLI 同库同构）；端口可用 `HARNESS_WEB_PORT` 覆盖

### 可选：接入真实 LLM API

演示 Provider 换**真实模型** = 换一个 `LLMProvider` 实现——
`OpenAICompatibleProvider`（`src/llm/openai-compatible-provider.ts`）覆盖任意
OpenAI 兼容服务（DeepSeek / OpenAI / 硅基流动 / Moonshot / 智谱 / 通义 /
Ollama / llama.cpp / one-api 网关…）。两种接入方式，同一个构造点。

**方式一：`.env` / 环境变量**（CLI 生效；网页启动时的缺省）

```bash
cp .env.example .env      # 编辑三个变量（模板含注释与示例）
# HARNESS_LLM_API_KEY=sk-…              API 密钥（本地服务留空）
# HARNESS_LLM_BASE_URL=https://api.deepseek.com/v1
# HARNESS_LLM_MODEL=deepseek-chat
pnpm chat                 # 启动行显示「[模型] 真实 API：deepseek-chat @ …」
```

判定规则：`API_KEY` 或 `BASE_URL` 任一存在即启用真实模式；三者皆缺省回落
离线演示——**地基行为不变**。

**方式二：网页「服务设置」面板**（运行时热切换，key 无需落盘）

```bash
pnpm web     # 顶栏「服务设置」→ 选预设服务商 / 填自定义 URL → 测试连通 → 应用
```

- **自由选择**：9 项预设（DeepSeek / OpenAI / 硅基流动 / Moonshot / 智谱 /
  通义 / Ollama / llama.cpp / 自定义），选中即填充 Base URL 与推荐模型；
- **连通测试**：先试免费路径 `GET /models`（无费用、无需模型名）；不可用时
  降级为最小对话请求——15s 快速失败，错误消息直接给出排查方向；
- **热切换**：应用后服务器**重建装配**（毫秒级）——会话与记忆在库里无缝
  延续，下一条消息即走新模型；查询进行中拒绝切换（409）；
- **key 安全**：仅存于本机浏览器（表单回填）与服务器内存——不落盘、不入库、
  永不回显（接口只回传「是否已配置」布尔）。

**无 key 先跑通全链路：本地 mock**

```bash
pnpm mock-llm    # 本地 OpenAI 兼容 mock（http://127.0.0.1:8099/v1，Ctrl+C 退出）
```

设置面板选「自定义」→ Base URL 填 `http://127.0.0.1:8099/v1` → 应用——从连通
测试到「工具四步链 + 流式总结」全部走**真实 HTTP + SSE 协议**，除模型本身之外
的一切都是真的。彩蛋：模型名填 `mock-500` / `mock-401` / `mock-slow` 可演示错误
映射、重试判定与慢流。

> 为什么不内置重量级 SDK？Chat Completions 协议是事实标准，一个类（约 600 行）
> 即可覆盖全生态；SSE 解析 / tool_calls 分片组装 / 错误映射全部可单测（本地 http
> 服务模拟线路，不碰真实 API）——零依赖且完全可读，教育价值高于封装依赖。

---

## 命令一览

| 命令 | 作用 | 备注 |
|---|---|---|
| `pnpm install` | 安装依赖 | 依据 `package.json` + `pnpm-lock.yaml` |
| `pnpm typecheck` | 类型检查 | `tsc --noEmit`，零错误 |
| `pnpm test` | 三层测试套件 | 31 文件 / 351 用例；`pnpm test:watch` 进入监听模式 |
| `pnpm lab` | 九幕端到端演示 | `scripts/lab.ts`——既是冒烟证据，也是「装配手册」 |
| `pnpm scenarios` | 12 场景评估集 | 仓库根 `scenarios/`；报告 + CI 退出码 |
| `pnpm chat` / `pnpm dev` | CLI 对话 | 同上「可选」节 |
| `pnpm web` | 网页观测台 | 第四条壳（HTTP+SSE）；六阶段 + 七层可视化 |
| `pnpm mock-llm` | 本地 OpenAI 兼容 mock | 连通测试靶子；无 key 演示真实协议全链路 |

---

## 一次 query 的完整数据流

```text
用户输入
  │
  ▼
(1) 命令拦截 ─── /command 命中 → 就地处理（零 LLM 调用），否则继续
  │
  ▼
(2) 会话就位 ─── 显式 id / --continue；状态门控 → 崩溃现场自动补位恢复
  │
  ▼
(3) 上下文组装 ── 5 层分层预算（默认 16k）+ 多级压缩 + 记忆检索注入
  │
  ▼
(4) 模型调用 ─── Provider.stream → StreamAssembler 显式状态机（ADR-008）
  │
  ▼
(5) tool_calls 判定 ── 无 → 自然终结（completed → 落盘）
  │ 有
  ▼
(6) 工具执行 ×N ─ 单次四步管道：pre-hook → 权限门 → execute → post-hook
  │               拒绝/拦截不中断循环——以 permission_denied 结果回注
  │               模型（ADR-005：「权限是对话的一部分」）
  ▼
(7) 结果回写 ─── 配对契约（每个 toolCall 必有 tool 结果）→
                 轮次边界原子落盘 → 回到 (3)，直到终结
```

编号与 `docs/01-architecture.md` §3 的数据流图一一对应。

---

## 仓库结构

```text
harness-lab/
├── src/            框架源码（核心手写——读书主体，见下方「模块导览」）
├── tests/          三层测试套件：unit / integration / scenarios
├── scenarios/      完整场景集（12 场景「场景即数据 + 行为断言」）
├── scripts/        lab.ts（九幕演示 / 装配手册）+ web.ts（网页观测台）+ mock-llm.ts（本地兼容 mock）+ smoke-ts.ts
├── web/            网页控制台前端（index.html + styles.css + app.js，零依赖）
├── docs/           学习文档链（00 环境 → 01 架构 → 02 决策 → 03 导览 → 04 对照）
├── data/           运行时产物（SQLite / 日志；已 gitignore，可整体清空重建）
├── package.json    依赖与命令声明（pnpm install 的唯一依据）
├── tsconfig.json   编译器契约（erasableSyntaxOnly + .ts 扩展名导入）
└── vitest.config.ts 测试配置（forks 池——Windows 下的确定性优先）
```

---

## 模块导览（读代码的分组地图）

| 分组 | 模块 | 一句话职责 | 入口 |
|---|---|---|---|
| 查询引擎 | LLM | Provider 抽象（Fake / OpenAI 兼容真实）+ 流式组装状态机 + 重试 | `src/llm/*` |
| 内核 | Agent Loop / Dispatcher / EventBus | 轮次驱动 · 单次工具四步管道 · 全链路事件流 | `src/kernel/*` |
| 能力层 | Tools / Context / Memory | 工具协议与校验 · 分层预算与压缩 · 长期记忆 | `src/tools/*` `src/context/*` `src/memory/*` |
| 保障层 | Permission / Session / Hooks | 风险分级+确认+审计 · 状态机+检查点恢复 · 5 种 outcome 管道 | `src/permission/*` `src/session/*` `src/hooks/*` |
| 编排层 | Skills / Commands / Sub-agent | 确定性编排 · 斜杠命令拦截 · Agent-as-Tool + 并发池 | `src/skills/*` `src/commands/*` `src/subagent/*` |
| 横切 | Observability / Eval | Tracer 环形缓冲 + 四维成本账本 · 场景即数据 + 行为断言 | `src/observability/*` `src/eval/*` |
| 组装 | CLI | 芯（`handleLine` 纯逻辑）/ 壳（REPL）分离 | `src/cli/*` |
| 对照层 | LangGraph 适配 | 同一 Loop 的框架表达（叶子模块，可整体删除） | `src/adapters/langgraph/*` |
| 预留 | MCP / Web-SSE / STT / Teams | 接口保留、零实现（ADR-010，可整体删除） | `src/placeholders/*` |

逐模块的关注点、实现状态与「必答问题」（学完自测 / 后续互相质询的题源）见
`docs/03-module-guide.md` §2。

---

## 学习文档链（建议按序阅读）

| 文档 | 回答的问题 |
|---|---|
| `docs/00-environment.md` | 开发环境事实核查与避坑（换机/升级后先更新它，再改代码） |
| `docs/01-architecture.md` | 总体架构：设计哲学 → 十层对照 → 数据流 → 目录 → 关键接口 |
| `docs/02-design-decisions.md` | ADR-001~012：每个关键取舍的「背景 → 决策 → 代价」 |
| `docs/03-module-guide.md` | 模块导览与学习路线（每条路线末尾的「必答问题」是掌握度标尺） |
| `docs/04-langgraph-comparison.md` | 用 LangGraph 重表达同一 Loop 的对照笔记（附实测结论） |

**建议阅读顺序**：先跑通上面「快速开始」，再按 01 的 §0 + §3 建立形状；
然后以 `pnpm scenarios` 的 12 个场景为练习题——每个场景都是一份
「给系统出题、用行为断言收卷」的样板，新场景 = 一个纯数据对象 + 断言函数
（照抄 `scenarios/` 任一文件即可）。

---

## 常见问题

- **数据可以清空吗？** 可以。`data/` 全部是运行时产物（`pnpm lab` 写
  `data/lab.db`，`pnpm chat` 写 `data/cli.db`），删掉后演示会自动重建；
  场景集的会话库使用系统临时目录，不污染仓库。
- **为什么必须 Node ≥ 26？** 依赖 `node:sqlite`（内置数据库，零原生依赖）与
  原生 type-stripping（`node xxx.ts` 直接跑）；详见 ADR-006 / ADR-012。
- **为什么源码 import 带 `.ts` 扩展名？** `erasableSyntaxOnly` + `rewrite
  RelativeImportExtensions` 的组合约定，换来零转译依赖与最接近运行时的
  调试体验（ADR-012）；scripts 默认用 tsx 运行以兼容生态习惯。
- **Windows 下有什么坑？** 见 `docs/00-environment.md` §4 坑点清单
  （PowerShell 用 `;` 分隔、不用重定向写文件、控制台编码 65001 等）。

---

## License

MIT（见 `package.json`）。
