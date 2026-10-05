# 04 · LangGraph 对照笔记（w16）

> **实验设定**：唯一变量是「控制流宿主」。同一个 FakeProvider 脚本、同一个
> Dispatcher（四步执行链）、同一个 HarnessConfig——只有「谁来编排轮次」不同。
> 全部结论都有测试实证：`tests/integration/langgraph-adapter.test.ts`（4 用例全绿，
> 2026-10 实测）。源码：`src/adapters/langgraph/`。

---

## 1. 同一个循环，两种表达

### 1.1 核心对照表

| 概念 | 我们的 AgentLoop | LangGraph（v1.4，@langchain/langgraph） |
| --- | --- | --- |
| 状态 | 手工可变数组 `messages` + `usageTotals` + `turns` | `Annotation.Root` 定义通道；节点返回 patch，引擎按 reducer 合并 |
| 消息追加 | `messages.push(...)` | `reducer: (prev, patch) => prev.concat(patch)` |
| 轮次计数 | `turns += 1` | `reducer` 相加 + 节点返回 `{ turns: 1 }` |
| 循环边界 | `while(true)` + `break`（四个出口） | 节点 + 条件边：`model →(有 toolCalls?)→ tools →(turns>=M?)→ model/END` |
| 自然终结 | 无 toolCalls → `completed` | `routeAfterModel` 返回 `END` |
| 预算终止 | 轮头检查 `turns >= maxTurns` → `max_turns` | `routeAfterTools` 返回 `END`（语义等价的时点） |
| 取消 | 轮头检查 + 流中检查 + 捕获收敛为 `aborted` | `config.signal` 穿透进节点；异常穿过引擎后由 runner 收敛 |
| 状态落盘 | `onTurnEnd` 接缝（轮次边界） | checkpointer（**每个 super-step** 自动） |
| 依赖注入 | 构造器收齐（provider/dispatcher/registry…） | 图工厂闭包捕获，节点只是函数 |

### 1.2 语义对齐是「设计出来的」，不是「碰巧的」

最容易做错的一处：**max_turns 边界**。我们 while 循环的检查在**轮头**——
所以「第 M 批工具」会先执行完，再在下一轮头停止。如果 LangGraph 版把
条件边写成 `model →(turns<M)→ tools`，就会少执行最后一批工具（新手常见写法）。
本层的边（`tools →(turns>=M)→ END`）就是为对齐这个时点设计的——§2 测试
逐条锚定（含「脚本耗尽自动暴露多消费」）。

### 1.3 行数对照（同口径：控制流宿主这一层）

| 实现 | 行数 | 说明 |
| --- | --- | --- |
| `kernel/agent-loop.ts` | ~515 | 含流式转发、事件记账、取消协议、持久化接缝、错误分类 |
| `adapters/langgraph/graph.ts + runner.ts` | ~380 | 只含控制流 + 契约对齐；事件/取消细节靠 runner 补齐 |
| LangGraph 引擎本身 | 黑盒（数万行） | 不读源码，就不知道状态合并/中断/并发的真实行为 |

数字本身不说明优劣，说明的是**账目位置**：我们的行数买的是「显式语义」
（每一行都可指认职责）；LangGraph 省下的行数是「引擎内部契约」——
省心，但那些契约的行为要靠文档与实验去发现（本笔记就是一次实验记录）。

---

## 2. 框架白送的能力（我们手写了的对应物）

| 能力 | LangGraph | 我们的对应物 | 差距评价 |
| --- | --- | --- | --- |
| 状态持久化 | `MemorySaver` / 各 Sqlite/Postgres checkpointer | `session/` 模块（SQLite + 轮次快照 + keepLast） | 我们更贴业务（会话生命周期），框架更通用 |
| 恢复执行 | `getState` + `invoke(null)` 从 checkpoint 续跑 | SessionManager 恢复流程（装载 + 补位 + 续 query） | 语义不同，见 §4 |
| 时间旅行 / 分叉 | `getStateHistory` + `updateState`（挂到任意历史态重跑） | **无**（会话单向追加是刻意的审计选择） | 框架强项；我们的「不可变审计」是另一个方向 |
| 流式事件 | `stream()` 多模式（updates/values/messages/custom） | EventBus（系统诊断流）+ LoopEvent（用户对话流）双通道 | 我们刻意分开「给人看」与「给机器记账」 |
| 人机协同中断 | `interrupt()` + checkpoint（暂停-恢复） | permission 确认（阻塞式 confirm）+ `placeholders/web-sse.ts`（异步票据形状） | 我们当前阶段选「阻塞」保可讲解性；解冻 Web 形态时面临真选择 |
| 动态 fan-out | `Send` API | `subagent/orchestrator.ts`（fan-out + 并发池） | 我们已按需实现；Send 的图内动态派生是另一种表达 |
| 并发执行 | super-step 内多节点并行（Pregel 调度） | dispatcher 串行（决意）+ pool 有界并发（子代理） | 我们刻意串行工具、并发限制在编排层 |

---

## 3. 框架隐藏的细节（被抽象吃掉、但你必须自己想的）

这些是本项目「核心手写」的价值清单——在 LangGraph 方案里同样绕不开：

1. **重试边界**：流式调用中途失败不能重放（会重复输出）。我们的安全边界
   「未收到任何事件前可重试」是显式设计（`llm/retry.ts`）；引擎不知道
   你的「首事件」语义。
2. **上下文预算/裁剪**：分层预算 + 压缩链（`context/`）完全在应用侧——
   state 里放多少消息、给模型看哪段投影，checkpointer 不管。
3. **错误分类学**：`HarnessError` 五码（哪些给模型看、哪些向上抛、
   哪些算控制流）是一个**领域决策**，引擎只区分「节点抛错/不抛错」。
4. **中断配对补位**：assistant(tool_calls) ↔ tool(result) 的配对完整性
   是工具协议的硬约束。本层实测（§4）：取消穿过 LangGraph 后状态只剩
   在 checkpoint 里——补位仍要**我们自己的** `fillInterruptedToolResults`
   （来自 session 模块，纯函数，原样复用）。**框架送管道，协议自己写。**
5. **成本归因**：四维账本（session/query/subagent/model）是 w14 在事件流
   上建的——LangGraph 有 usage metadata，但「账本语义」（定价权、未定价
   策略、子代理归因）是业务设计。
6. **工具四步链**：权限确认、hook 生命周期、超时、审计事件——本层复用
   Dispatcher 即得；从零用 LangChain 工具生态重建这些，等价于重写一遍内核。

---

## 4. 必答问题：checkpoint 语义差异（实测锚定）

**我们的 checkpoint**（`session/checkpoint.ts` + `store`）：
- 粒度：**轮次边界**——onTurnEnd 快照（工具批写回后的一致性点）；
- 内容：会话消息链快照（+ turn），keepLast 保留最近 N 份；
- 写入者：SessionManager（业务层）——Loop 不知道持久化的存在（依赖倒置）；
- 恢复方式：装载最近快照 → 推导 pending → **补位** → 从「续」开始；
- 目的：会话延续 + 崩溃恢复 + **绝不重放已完成工具**。

**LangGraph checkpoint**（MemorySaver 实测）：
- 粒度：**每个 super-step**——同一次 2 轮 query 实测 5 条（输入 / model#1 后 /
  tools#1 后 / model#2 后 / 终态）；我们同场景只有 **1 次**轮次边界快照（§3 测试）；
- 内容：整个 State（任意自定义通道）+ 引擎元数据（next 节点、版本链）；
- 写入者：引擎内建（compile 时挂 checkpointer，自动落）；
- 恢复方式：`getState`/`invoke(null)` 从任意 checkpoint 续跑（甚至分叉重跑）；
- 目的：**执行恢复的通用基础设施**——interrupt、时间旅行、重试都建立在它上面。

**一句话结论**：LangGraph 的 checkpoint 是「执行引擎的进程快照」，我们的
checkpoint 是「会话的业务存档」；前者回答「机器执行到哪了」，后者回答
「这段对话是什么」。本层的取消恢复实证了互补关系：引擎快照负责把状态
活着捞回来，业务纯函数负责把它修成协议合法的形态。

---

## 5. 结论：什么时候用哪个

- **选 LangGraph**：需要快速编排复杂多节点流程、时间旅行/人工审批/
  可视化调试是刚需、团队接受「引擎契约进黑盒」的工程成本。
- **选手写（本项目的路线）**：把「全链路可讲解、可审计、可回答每一个
  为什么」当作第一优先级；领域语义（配对协议、账本、权限模型）比编排
  拓扑更重；不想为读文档/读引擎源码支付学习成本。
- **两条都成立**：本对照层证明「内核可以完全不知道 LangGraph 的存在」
  （adapters 是叶子、devDependency、可整体删除）——框架是**宿主**，
  领域能力（Dispatcher/Session/Context/Observability）是自己的资产。
