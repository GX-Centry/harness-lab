/**
 * 【接口保留】Web / SSE —— 把「阻塞式 REPL」升级为「多客户端事件流」。
 *
 * 状态：ADR-010「暂缓」——只保留接口与接入点分析，不实现 HTTP/SSE 传输。
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 为什么暂缓（与当前形态的真实冲突）                                     │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * ① 交互模型：REPL 是「一问一答」的阻塞循环（readline 等用户输入）；
 *    Web 是**多客户端并行** + 每连接一条事件流——会话与连接的生命周期解耦
 *    （浏览器关掉页签，后台的 query 该继续还是取消？）。
 *
 * ② 权限确认必须异步化：CLI 里 confirm 是「编辑器输入流上的一个 Promise」
 *    （30s 超时默认拒绝，见 permission 模块）；Web 形态下确认票据要**跨
 *    请求存活**——提问在 SSE 流里推出，回答来自另一个 HTTP POST，两者可能
 *    隔着用户离开页面喝咖啡的 10 分钟（超时策略需重定：CLI 的 30s 是桌面
 *    直觉，Web 需要按业务定）。
 *
 * ③ 取消语义：浏览器断开 SSE 连接 → 需要把 AbortSignal 级联到当前 query
 *    （我们的 Loop 已支持 signal 穿透——这一层是「事件桥」，不是内核改动）。
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 好消息：接口早已留门（不是巧合，是 w06 的设计）                        │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * - PermissionGate 的确认通道从第一天起就是**异步接口**
 *   （ConfirmHandler: (request) => Promise<Decision>，见 permission/gate.ts）——
 *   CLI 的实现（readline + 超时）只是它的**一种**实例；
 *   `AsyncConfirmationBroker`（下文）就是 Web 形态的另一种实例，
 *   可直接装配进 PermissionGate，内核零改动。
 * - EventBus 的订阅机制（'*' + seq 有序）天生就是「事件流广播源」——
 *   SSE 桥只需订阅总线并把事件翻译为 SSE 帧。
 * - 本文件故意复用 permission 模块的事件形状（tool permission_decision），
 *   避免「两种确认语义」并行。
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 未来接入点（解冻时按此接线）                                           │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * 1. `createSseBridge(bus)`：订阅 '*' → 按 queryId 分流 → 每个连接一个
 *    AsyncIterable<WebSseEvent> → HTTP 层（如原生 http + text/event-stream）。
 * 2. `AsyncConfirmationBroker`（实现 ConfirmHandler）装配进 PermissionGate：
 *    票据入 Map（带 id）→ SSE 推出 confirmation_request → 前端 POST
 *    /confirm/:id → broker.resolve(id, decision) 兑现 Promise。
 * 3. 断连风暴防护、心跳（SSE 注释帧）、事件序号补发（Last-Event-ID）——
 *    这些是传输层细节，解冻时在 HTTP 层实现，不污染内核。
 *
 * 解冻条件：出现「Web 前端 / 多客户端」的真实需求（如团队内部试用发放
 * Web 入口），且确认超时策略按业务重新定稿。
 *
 * 依赖说明：零运行时依赖。AsyncConfirmationBroker 的**接口形状**与
 * permission/ConfirmHandler 对齐——解冻时只需补实现，不需要改内核签名。
 */

// ===========================================================================
// §1 SSE 帧与事件流形状
// ===========================================================================

/** SSE 帧（event: <name>\ndata: <json>）——data 建议为 JSON.stringify(event) */
export interface WebSseEvent {
  readonly event: string;
  readonly data: string;
}

/**
 * 会话事件通道：一个连接（或一个 queryId）对应一条流。
 * 实现方（解冻时）：内部订阅 EventBus → 推入队列 → 传输层消费。
 */
export interface WebSessionChannel {
  /** 订阅某条 query 的事件流（直到 query 终结或客户端断开） */
  subscribe(queryId: string): AsyncIterable<WebSseEvent>;
  /** 单向推送（心跳、系统通知等总线外消息） */
  push(event: WebSseEvent): void;
}

// ===========================================================================
// §2 异步确认票据（Web 形态的 ConfirmHandler 实现形状）
// ===========================================================================

import type { PermissionRequest } from '../permission/gate.ts';

/**
 * 待确认票据：「危险工具调用」在等一个人类回答。
 * 内核请求形状（sessionId / queryId / toolName / risk / input）直接复用
 * PermissionRequest——票据只加「自身的路由信息」（id + 发起时间），
 * 不复制内核字段（避免两处形状各自漂移）。
 */
export interface PendingConfirmation {
  readonly id: string;
  readonly requestedAt: number;
  /** 内核发来的确认请求原样携带（审核展示「危险在哪」的全部依据） */
  readonly request: PermissionRequest;
}

/**
 * 异步确认经纪人——本文件最有价值的形状：它**就是** ConfirmHandler
 * （(request) => Promise<boolean>，见 permission/gate.ts L56）在 Web 形态
 * 下的展开。返回 boolean 与内核签名严格一致：允许 = true。
 *
 * 生命周期（解冻时实现）：
 *   1. PermissionGate 调 confirm(request) → broker.request() 生成票据入表，
 *      返回一个「悬而未决」的 Promise；
 *   2. 票据经 SSE 推给前端 → 用户点击 → POST 回来 → resolveById 兑现；
 *   3. 超时（策略待定稿）→ 自动拒绝（false）并清理票据。
 *
 * 为什么先定形状而不是先实现：它暴露了 w06 的一个真实设计输入——
 * 「确认是跨进程/跨请求的异步状态机」，CLI 的 30s readline 只是简化的特例。
 */
export interface AsyncConfirmationBroker {
  /** 发起确认（PermissionGate 的 confirm 通道直接指向此方法；false = 拒绝） */
  request(ticket: PendingConfirmation): Promise<boolean>;
  /** 前端回答（POST /confirm/:id 的落点）；未知 id 返回 false */
  resolveById(id: string, allowed: boolean): boolean;
  /** 当前所有待决票据（管理面板 / 调试用） */
  pending(): readonly PendingConfirmation[];
}
