/**
 * 【接口保留】MCP（Model Context Protocol）—— 外部工具生态的接入位。
 *
 * 状态：ADR-010「暂缓」——只保留接口与接入点分析，不实现连接逻辑。
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 为什么暂缓（与当前形态的真实冲突）                                     │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * ① 连接生命周期：我们的工具是「进程内函数」（Tool.execute：调用即执行、
 *    无资源管理）；MCP 工具住在**长驻外部进程**里（stdio 子进程 / HTTP 服务），
 *    需要 connect / 健康检查 / 重连 / 退出清理——长驻连接管理与「单进程
 *    CLI」形态直接冲突（CLI 退出时如何保证子进程收尸？）。
 *
 * ② 权限语义未定：我们的风险分级（low/medium/high）是**开发者声明**的
 *    （Tool.risk，见 types.ts）；MCP 工具的声明来自**第三方服务器**——
 *    「第三方自称 low 风险」不可采信。接入前需要一套信任分级策略
 *    （如：MCP 工具默认至少 medium + 服务器白名单）——这是安全设计决策，
 *    不是实现细节。
 *
 * ③ schema 体系不同：我们的工具协议用 zod（Tool.inputSchema +
 *    validateToolInput）；MCP 用 JSON Schema。接入需要「JSON Schema →
 *    校验函数」的桥（或旁路双校验策略）。
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 未来接入点（解冻时按此接线，内核零改动）                                │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * - `McpClient.listTools()` → 每个 McpToolDescriptor 适配为一个 AnyTool：
 *     name:        `${serverName}_${toolName}`（命名空间防冲突）
 *     risk:        信任策略映射（冲突 ② 的裁决产物）
 *     inputSchema: JSON Schema → zod 桥（冲突 ③）
 *     execute:     await client.callTool(toolName, args)
 *   然后 ToolRegistry.register(...)——四步执行链（hooks / permission /
 *   超时）对 MCP 工具**零感知**地生效：这是「所有工具收敛到 Dispatcher
 *   唯一入口」的架构红利。
 * - `McpClient.connect() / disconnect()` 挂到 CLI 生命周期（启动 / 退出）。
 *
 * 解冻条件（两者同时成立）：
 *   1. 出现「接入第三方工具生态」的真实需求；
 *   2. 信任分级策略定稿（冲突 ② 的裁决记录进 02-design-decisions.md）。
 *
 * 依赖说明：本文件零运行时依赖（只有类型）——「死代码」不是运行时资产，
 * 删除本目录内核不受任何影响（ADR-010 的代价与收益已在决策中记录）。
 */

// ===========================================================================
// §1 传输层形状（对齐 MCP 规范的两种主流传输）
// ===========================================================================

/** 服务器传输方式：stdio = 本地子进程；http = 远程服务（Streamable HTTP / SSE） */
export type McpTransport =
  | {
      readonly kind: 'stdio';
      readonly command: string;
      readonly args?: readonly string[];
      readonly env?: Readonly<Record<string, string>>;
    }
  | { readonly kind: 'http'; readonly url: string };

/** 服务器配置（未来进 config.ts 的草案形状——故意不提前加：避免「配置了却不生效」） */
export interface McpServerConfig {
  readonly name: string;
  readonly transport: McpTransport;
  /** 信任级别：冲突 ② 的裁决产物（语义待定稿——先留枚举形状） */
  readonly trust: 'trusted' | 'untrusted';
}

// ===========================================================================
// §2 协议面形状（工具发现 + 调用）
// ===========================================================================

/** 服务器声明的工具（JSON Schema 形状——非 zod，桥接点见文件头冲突 ③） */
export interface McpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/** 调用结果：内容 + 错误标志（对齐 MCP 的 isError 语义——调用完成 ≠ 业务成功） */
export interface McpCallResult {
  readonly content: string;
  readonly isError: boolean;
}

/**
 * 客户端抽象：连接管理 + 工具发现 + 调用。
 * 解冻时替换为真实实现（官方 SDK 或自写 JSON-RPC over stdio）——
 * 本接口刻意只暴露接入 ToolRegistry 所需的最小面。
 */
export interface McpClient {
  readonly serverName: string;
  connect(): Promise<void>;
  listTools(): Promise<readonly McpToolDescriptor[]>;
  callTool(name: string, args: unknown): Promise<McpCallResult>;
  /** 幂等：重复 disconnect 是 no-op（与 Tracer/CostTracker.dispose 同一约定） */
  disconnect(): Promise<void>;
}
