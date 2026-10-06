# harness-lab

[中文](README.md) · English

[![CI](https://github.com/GX-Centry/harness-lab/actions/workflows/ci.yml/badge.svg)](https://github.com/GX-Centry/harness-lab/actions/workflows/ci.yml)

> A from-scratch, **teaching-grade Agent Harness** in TypeScript: Agent Loop / Tool
> Dispatch / Context / Permission / Session / Hook — full stack, plus a LangGraph
> comparison adapter layer. The core has **zero agent-framework dependencies**
> (only `zod` for schemas, built-in `node:sqlite` for storage).

## What is this

- **Premise**: an agent's real battlefield is not the model — it is the harness.
- **Three ground rules** (full rationale: [docs/01-architecture.md](docs/01-architecture.md) §0):
  1. **Hand-written core, framework side-by-side** — Loop / Dispatch / Context / Permission / Session / Hooks are implemented from scratch (they *are* the learning subject); LangGraph appears only in the comparison layer.
  2. **Determinism first** — every external dependency (LLM / clock / randomness) is replaceable; a FakeProvider makes all tests and demos run **offline with zero API keys**.
  3. **Code is the tutorial** — comments answer "what role does this stage play" and "why this design, at what cost".
- **What ships**: three-layer test suite (unit / integration / scenarios) + a nine-act end-to-end demo (`pnpm lab`) + a 12-scenario evaluation set (`pnpm scenarios`, with CI exit-code semantics).
- **Origin**: the ten-layer mental model comes from the final-project (OfferPilot) of the zero2Agent tutorial, rewritten as a standalone, testable, evaluable implementation.

## Run it in 30 seconds

Prerequisites: Node.js **≥ 26** + pnpm 11 (measured versions & pitfalls: [docs/00-environment.md](docs/00-environment.md)).

```bash
pnpm install     # install dependencies
pnpm test        # ① three-layer suite: 31 files / 351 cases green (~9s)
pnpm lab         # ② nine-act end-to-end demo
pnpm scenarios   # ③ 12-scenario evaluation report (~100ms, CI-ready exit code)
```

Expected closing lines:

```text
Test Files  31 passed (31) · Tests  351 passed (351)
✔ 全部幕次执行完毕——九条路径均已演示。
评测报告：12/12 通过——断言「行为」而非文本
```

Full outputs, CI exit-code semantics and network/encoding pitfalls → [docs/05-usage.md](docs/05-usage.md).

> Note: the detailed docs (docs/00–05) are currently written in Chinese; this page
> mirrors the full entrance and roadmap so English readers can navigate.

## Where to go next

| What you want to solve | Where to read |
|---|---|
| The big picture: philosophy → ten-layer map → data flow → interfaces | [docs/01-architecture.md](docs/01-architecture.md) |
| Every key trade-off (ADR-001~012: context → decision → cost) | [docs/02-design-decisions.md](docs/02-design-decisions.md) |
| Read module by module + self-check "must-answer" questions | [docs/03-module-guide.md](docs/03-module-guide.md) |
| The same Loop re-expressed in LangGraph | [docs/04-langgraph-comparison.md](docs/04-langgraph-comparison.md) |
| Run the CLI / web console / real LLM APIs | [docs/05-usage.md](docs/05-usage.md) |
| Environment facts & pitfalls (read before switching machines) | [docs/00-environment.md](docs/00-environment.md) |

**Recommended path**: run the four commands above → read §0 + §3 of docs/01 to
build the shape → use the 12 scenarios in `scenarios/` as exercises (a new
scenario = one plain data object + an assertion function — copy any file in
`scenarios/`).

## Repository layout

```text
harness-lab/
├── src/         framework source (the reading subject) — llm / kernel / tools /
│                context / memory / permission / session / hooks / skills /
│                commands / subagent / observability / eval / cli / adapters /
│                placeholders
├── tests/       three-layer suite: unit / integration / scenarios
├── scenarios/   12-scenario evaluation set (scenarios as data + behavioral assertions)
├── scripts/     lab.ts (nine-act demo) + web.ts (web console) + mock-llm.ts + smoke-ts.ts
├── web/         web console frontend (zero dependencies)
├── docs/        learning doc chain 00→05 (the detail branches behind the table above)
└── data/        runtime artifacts (SQLite; gitignored, safe to wipe and rebuild)
```

Module groups and learning routes → [docs/03-module-guide.md](docs/03-module-guide.md);
full architecture & directory guide → [docs/01-architecture.md](docs/01-architecture.md).

## License

MIT (see `package.json`).
