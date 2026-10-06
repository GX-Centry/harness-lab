# harness-lab

中文 · [English](README_en.md)

[![CI](https://github.com/GX-Centry/harness-lab/actions/workflows/ci.yml/badge.svg)](https://github.com/GX-Centry/harness-lab/actions/workflows/ci.yml)

> 从零手写的**教学级 Agent Harness 框架**：Agent Loop / Tool Dispatch / Context /
> Permission / Session / Hook 全栈实现，附 LangGraph 对照适配层。
> 核心工程层**零 Agent 框架依赖**（仅 zod 做 schema 校验、`node:sqlite` 做存储）。

## 这是什么

- **前提判断**：Agent 的主战场不在模型，在 Harness。
- **三条铁律**（论证全文见 [docs/01-architecture.md](docs/01-architecture.md) §0）：
  1. **核心手写、框架对照**——Loop / Dispatch / Context / Permission / Session / Hook 全部从零实现（学习对象本身）；LangGraph 只出现在对照层。
  2. **确定性优先**——FakeProvider 打底，全部测试与演示**离线可跑、零 API Key**。
  3. **代码即教程**——注释回答「这一环扮演什么角色」「为什么这样设计、代价是什么」。
- **交付形态**：三层测试套件（unit / integration / scenarios）+ 九幕端到端演示（`pnpm lab`）+ 12 场景评估集（`pnpm scenarios`，带 CI 退出码语义）。
- **来源**：心智模型源自 zero2Agent 教程的 final-project（OfferPilot），重写为一套**可独立运行、可测试、可评测**的实现。

## 30 秒跑起来

前置：Node.js **≥ 26** + pnpm 11（实测版本与避坑见 [docs/00-environment.md](docs/00-environment.md)）。

```bash
pnpm install     # 安装依赖
pnpm test        # ① 三层测试：31 文件 / 351 用例全绿（~9s）
pnpm lab         # ② 九幕端到端演示（~秒级）
pnpm scenarios   # ③ 12 场景评估报告（~100ms，带 CI 退出码）
```

预期收官：

```text
Test Files  31 passed (31) · Tests  351 passed (351)
✔ 全部幕次执行完毕——九条路径均已演示。
评测报告：12/12 通过——断言「行为」而非文本
```

完整输出、CI 退出码语义、网络与中文编码避坑 → [docs/05-usage.md](docs/05-usage.md)。

## 我该读什么（导航入口）

| 你想解决的问题 | 去哪里 |
|---|---|
| 建立整体形状：设计哲学 → 十层对照 → 数据流 → 关键接口 | [docs/01-architecture.md](docs/01-architecture.md) |
| 理解每个关键取舍（ADR-001~012：背景 → 决策 → 代价） | [docs/02-design-decisions.md](docs/02-design-decisions.md) |
| 逐模块读代码 + 用「必答问题」自测掌握度 | [docs/03-module-guide.md](docs/03-module-guide.md) |
| 看同一 Loop 用 LangGraph 重表达是什么样 | [docs/04-langgraph-comparison.md](docs/04-langgraph-comparison.md) |
| 跑 CLI 对话 / 网页观测台 / 接入真实 LLM API | [docs/05-usage.md](docs/05-usage.md) |
| 环境事实核查与踩坑（换机 / 升级前先看） | [docs/00-environment.md](docs/00-environment.md) |

**推荐路径**：先跑通上面四条命令 → 读 01 的 §0 + §3 建立形状 → 以 `pnpm scenarios`
的 12 个场景为练习题（新场景 = 一个纯数据对象 + 断言函数，照抄 `scenarios/`
任一文件即可）。

## 仓库结构

```text
harness-lab/
├── src/         框架源码（读书主体）——llm / kernel / tools / context / memory /
│                permission / session / hooks / skills / commands / subagent /
│                observability / eval / cli / adapters / placeholders
├── tests/       三层测试套件：unit / integration / scenarios
├── scenarios/   12 场景评估集（场景即数据 + 行为断言）
├── scripts/     lab.ts（九幕演示）+ web.ts（网页观测台）+ mock-llm.ts + smoke-ts.ts
├── web/         网页控制台前端（零依赖）
├── docs/        学习文档链 00→05（上方导航的详情分支）
└── data/        运行时产物（SQLite；已 gitignore，可整体清空重建）
```

各模块职责分组与学习路线 → [docs/03-module-guide.md](docs/03-module-guide.md)；
完整架构与目录说明 → [docs/01-architecture.md](docs/01-architecture.md)。

## License

MIT（见 `package.json`）。
