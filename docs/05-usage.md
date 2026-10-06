# 05 · 使用手册（CLI / Web / 真实 LLM API）

> 学习链 00→04 回答「为什么这样设计」；本册是**操作附录**，回答「具体怎么用」：
> 快速开始的完整输出、命令清单、CLI 与网页两种壳、接入真实模型的两种方式、常见问题。
> 按需查阅，不必按序阅读。

---

## §1 快速开始的完整输出

**环境要求**（实测版本与换机避坑见 `00-environment.md`）：

| 工具 | 版本 | 为什么 |
|---|---|---|
| Node.js | **≥ 26** | `node:sqlite` 内置稳定（ADR-006）+ 原生 type-stripping（ADR-012） |
| pnpm | 11 | 首选包管理器（用 npm 时等价替换为 `npm run <script>`） |

在仓库根目录依次执行：

```bash
pnpm install     # 安装依赖（zod + typescript / tsx / vitest / @types/node / @langchain/langgraph）
pnpm test        # ① 三层测试套件：34 个文件 / 415 用例全绿（~9s）
pnpm lab         # ② 九幕端到端演示：A→I 全部路径 + 终幕读回（~秒级）
pnpm scenarios   # ③ 12 场景评估报告：行为断言 + CI 退出码（~100ms）
```

各步骤的预期关键输出：

```text
# pnpm test
 Test Files  34 passed (34)
      Tests  415 passed (415)

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

---

## §2 命令一览

| 命令 | 作用 | 备注 |
|---|---|---|
| `pnpm install` | 安装依赖 | 依据 `package.json` + `pnpm-lock.yaml` |
| `pnpm typecheck` | 类型检查 | `tsc --noEmit`，零错误 |
| `pnpm test` | 三层测试套件 | 34 文件 / 415 用例；`pnpm test:watch` 进入监听模式 |
| `pnpm lab` | 九幕端到端演示 | `scripts/lab.ts`——既是冒烟证据，也是「装配手册」 |
| `pnpm scenarios` | 12 场景评估集 | 仓库根 `scenarios/`；报告 + CI 退出码 |
| `pnpm chat` / `pnpm dev` | CLI 对话 | 见本册 §3 |
| `pnpm web` | 网页观测台 | 第四条壳（HTTP+SSE）；六阶段 + 七层可视化 |
| `pnpm mock-llm` | 本地 OpenAI 兼容 mock | 连通测试靶子；无 key 演示真实协议全链路 |
| `pnpm preflight` | 环境预检（体检报告） | Node / 平台 / bash·git / 环境变量冲突；error 时退出码 1 |

---

## §3 CLI 对话形态（交互 REPL）

```bash
pnpm chat                        # 交互式 REPL（/exit 退出 · Ctrl+C 取消当前对话）
pnpm chat -p "帮我算 12*(3+4)"    # 单次问答后退出（脚本友好）
pnpm chat --session demo         # 指定 / 复用会话（不存在则创建）
pnpm chat --continue             # 继续最近一次会话
pnpm chat --mode semi            # 权限模式：manual（缺省）/ semi / auto
pnpm chat --yes                  # 等价 --mode auto（无人值守 / 演示——旧习惯保留）
```

对话模式默认使用**规则驱动的确定性演示 Provider**（`src/cli/demo.ts`，离线、
零成本、可复现）——REPL 要展示的主体是会话 / 记忆 / 命令 / 子代理 / 权限这条
管道，而非模型的智能程度。要接**真实 OpenAI 兼容 API**（DeepSeek / OpenAI /
Ollama…）见 §5——换真实模型 = 换一个 `LLMProvider` 实现，替换点仍然只有一处。

**权限模式三档**（w18——「全自动 / 半自动」诉求的落点）：

| 模式 | 确认行为 | 适用 |
|---|---|---|
| `manual` | 每个确认决策都询问用户（缺省——行为不变） | 学习 / 审查每一步 |
| `semi` | low + medium 风险自动放行；high / critical 仍询问 | 日常使用 |
| `auto` | 全部自动批准（reason 如实标注「未询问用户」） | 无人值守 / 演示 |

安全边界不随模式消失：规则 `deny` 仍然拒绝、hook `block` 仍然阻断；manual /
semi 下没有确认通道（非交互终端）仍 fail-safe 拒绝。启动时可用 `--mode` /
`--yes` / 环境变量 `HARNESS_PERMISSION_MODE` 设定（后写胜）；运行中 `/mode`
随时切换——即时生效（不重启、不断会话）。

---

## §4 网页观测台（Web 形态）

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
  （见 §5）
- **权限模式**：顶栏 chip 显示当前模式（manual / semi / auto），点击循环
  切换——与 CLI 同一套语义，服务端为唯一真相源，广播即刷新
- 数据写入 `data/web.db`（与 CLI 同库同构）；端口可用 `HARNESS_WEB_PORT` 覆盖

---

## §5 接入真实 LLM API

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

## §6 常见问题

- **数据可以清空吗？** 可以。`data/` 全部是运行时产物（`pnpm lab` 写
  `data/lab.db`，`pnpm chat` 写 `data/cli.db`），删掉后演示会自动重建；
  场景集的会话库使用系统临时目录，不污染仓库。
- **为什么必须 Node ≥ 26？** 依赖 `node:sqlite`（内置数据库，零原生依赖）与
  原生 type-stripping（`node xxx.ts` 直接跑）；详见 ADR-006 / ADR-012。
- **为什么源码 import 带 `.ts` 扩展名？** `erasableSyntaxOnly` + `rewrite
  RelativeImportExtensions` 的组合约定，换来零转译依赖与最接近运行时的
  调试体验（ADR-012）；scripts 默认用 tsx 运行以兼容生态习惯。
- **Windows 下有什么坑？** 见 `00-environment.md` §4 坑点清单
  （PowerShell 用 `;` 分隔、不用重定向写文件、控制台编码 65001 等）。
- **启动时出现「环境预检未通过」怎么办？** 预检在启动前检查 Node 版本 /
  bash·git 可用性 / 环境变量冲突——error 才阻止启动（warn 只打一行提示）。
  先跑 `pnpm preflight` 看完整报告与处置建议（hint），修完再启动。
- **我设置了全局 `OPENAI_API_KEY`，为什么 harness 不认？** harness 只读
  `HARNESS_LLM_*` 三个显式变量（防跨工具串味）；预检检测到这类冲突会 warn
  提醒。显式设置或写进 `.env` 即可。
- **接入真实 API 后，技能（skill）怎么被模型调用？** 每个技能都以
  `skill_<名称>` 工具形式进入模型的 tools 参数，由模型自主决定何时调用
  （如「用技能出报告 21*2」）；也可用 `/skill` 命令手动执行——两条路径同链
  （都经 Dispatcher / 权限 / Hook）。`/hooks` 可查看 Hook 管道现状。
