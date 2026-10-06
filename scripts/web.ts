/**
 * harness-lab 网页控制台（第四条壳：HTTP + SSE）—— 「可观察外壳」。
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 定位：壳换了一种，装配一行没换                                        │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * 组装层已有三个实例（scripts/lab.ts 演示装配 / src/eval 剥光装配 /
 * src/cli/app.ts 产品装配）。本文件是**第四种壳**：消费 createCliApp 的
 * 同一个产品装配，把交互面从 readline 换成「HTTP + SSE + 浏览器」——
 * 不碰内核、不新增装配逻辑。这正是「组装是设计，壳是策略」的又一次兑现：
 *
 *   createCliApp(...)                     ← 装配（本文件零改动复用）
 *     ├─ 壳① repl.ts      （readline，终端交互）
 *     ├─ 壳② runOnce      （一次性，脚本/CI）
 *     └─ 壳③ web.ts       （本文件：浏览器，可观察/可分步/可回放）
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 核心机制①：双通道合并成一条 wire                                      │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * harness 的事件流本来是两条、消费者不同（见 kernel/events.ts 与
 * kernel/agent-loop.ts 的分工）：
 *
 *   bus.on('*')          HarnessEvent —— 机器诊断流（全链路事实）
 *   handleLine(line)     LoopEvent    —— 用户对话流（模型产出 + 工具活动）
 *
 * 网页的诉求是「两条都要、顺序还要对」。做法：两个生产者共用同一个
 * broadcast()，按**到达顺序**编号（n 单调递增）合并进一条 SSE ——
 * 浏览器拿到的就是一条严格有序的全量事实流。两个通道**不再各自加工**，
 * 归因/合并的推理全部放在浏览器端（web/app.js 的 buildModel）。
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 核心机制②：wire 回放缓冲（刷新 = 从头观看整场运行）                    │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * 服务器把所有已广播的消息留在内存 wire 里（上限 WIRE_LIMIT 条，超出丢
 * 头部）。新的 SSE 连接建立时：先发 hello 快照 → **同步重放全部 wire** →
 * 再进入实时推送。浏览器据此可以做「全程回放 / 单步前进 / 变速播放」
 * ——观察 harness 不再是「看一眼就没了」，而是可暂停、可回退的教具。
 * 客户端按 n 去重（重连会拿到重复前缀，n <= 已见最大值即忽略）。
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 核心机制③：权限确认桥（ConfirmHandler 的 HTTP 化身）                   │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * createCliApp 的 confirm 选项是依赖倒置的注入点：缺省恒拒绝（fail-safe，
 * 非交互环境的正确默认）。网页壳把它桥到浏览器：SSE 推 permission_prompt
 * → 用户点「批准 / 拒绝」→ POST /api/confirm → promise 兑现。
 * 120s 无人响应自动拒绝（与 PermissionGate 的安全默认一致）。
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ API 面（面向前端的全部词汇）                                          │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 *   GET  /               静态页（web/index.html + styles.css + app.js）
 *   GET  /api/stream     SSE：hello 快照 + wire 全量重放 + 实时消息
 *   GET  /api/session    会话快照（id/状态/忙闲）——调试与刷新用
 *   GET  /api/permission-mode  当前权限模式（mode + 描述 + 可选值表）
 *   POST /api/permission-mode  { mode } 切换权限模式（运行期即时生效；w18）
 *   GET  /api/provider   当前 Provider 元数据 + 预设服务商表（设置面板用）
 *   POST /api/query      { input } 提交一轮输入（单飞锁：忙时 409）
 *   POST /api/abort      中断当前 query（协作式取消）
 *   POST /api/confirm    { approve } 兑现待决的权限确认
 *   POST /api/provider   { kind:'demo' } | { kind:'real', baseUrl, model, apiKey }
 *                        热切换模型（重建装配毫秒级；会话在库里无缝延续）
 *   POST /api/provider/test  { baseUrl, model, apiKey } 连通测试（/models → 最小对话降级）
 *   POST /api/reset      新会话（dispose 旧 app → 重建；同库记忆保留）
 *
 * 绑定 127.0.0.1（本地教具，不暴露局域网）；端口 HARNESS_WEB_PORT（默认 4173）。
 */

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCliApp, createDemoProvider, describeError } from '../src/cli/index.ts';
import type { CliApp } from '../src/cli/index.ts';
import { defaultConfig, defineConfig } from '../src/config.ts';
import type { LoopEvent } from '../src/kernel/agent-loop.ts';
import type { HarnessEvent } from '../src/kernel/events.ts';
import {
  OPENAI_COMPATIBLE_PRESETS,
  OpenAICompatibleProvider,
  loadDotEnv,
  resolveRealProviderConfig,
} from '../src/llm/index.ts';
import type { RealProviderConfig } from '../src/llm/index.ts';
import type { ConfirmHandler } from '../src/permission/gate.ts';
import {
  describePermissionMode,
  parsePermissionMode,
  PERMISSION_MODES,
} from '../src/permission/modes.ts';
import { resolveStorePath } from '../src/session/store.ts';
import { userMessage } from '../src/types.ts';
import type { PermissionMode } from '../src/types.ts';

// 可选：把项目根 .env 载入环境（必须在任何 process.env 读取之前——含下方端口解析）
loadDotEnv();

// ===========================================================================
// §1 常量
// ===========================================================================

const HOST = '127.0.0.1';
const DEFAULT_PORT = 4173;
const CONFIRM_TIMEOUT_MS = 120_000; // 权限确认的浏览器等待上限（超时 = 拒绝）
const PING_INTERVAL_MS = 15_000; // SSE 心跳（穿越代理/防火墙的保活注释行）
const WIRE_LIMIT = 20_000; // 回放缓冲上限（教学规模：一场会话远小于此）

const parsedPort = Number(process.env['HARNESS_WEB_PORT'] ?? '');
const PORT = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT;

const WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url));

/** 静态白名单（三个文件，路径零拼接风险——不做通用文件服务器） */
const STATIC_FILES: ReadonlyMap<string, string> = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/styles.css', 'styles.css'],
  ['/app.js', 'app.js'],
]);

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

// ===========================================================================
// §2 线缆（wire）：双通道合并 + 回放缓冲 + 广播
// ===========================================================================

/**
 * 当前 Provider 的运行时描述（对前端的公开元数据——**不含 key 原文**，
 * 只回传「是否已配置」布尔）。
 */
interface ProviderInfo {
  readonly kind: 'demo' | 'real';
  readonly label: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly hasApiKey: boolean;
  readonly presetId?: string;
}

/** UI 层通知（壳自身的产品消息：对话气泡、权限横幅、忙闲等——非 harness 事件） */
type UiNotice =
  | { readonly ch: 'ui'; readonly type: 'query_submitted'; readonly input: string }
  | { readonly ch: 'ui'; readonly type: 'query_done'; readonly ok: boolean }
  | { readonly ch: 'ui'; readonly type: 'query_error'; readonly message: string }
  | {
      readonly ch: 'ui';
      readonly type: 'permission_prompt';
      readonly toolName: string;
      readonly risk: string;
      readonly input: unknown;
    }
  | {
      readonly ch: 'ui';
      readonly type: 'permission_settled';
      readonly approved: boolean;
      readonly reason: 'user' | 'timeout';
    }
  | { readonly ch: 'ui'; readonly type: 'reset'; readonly sessionId: string }
  | { readonly ch: 'ui'; readonly type: 'provider_changed'; readonly provider: ProviderInfo }
  | {
      readonly ch: 'ui';
      readonly type: 'permission_mode_changed';
      readonly mode: PermissionMode;
      readonly description: string;
    };

/** 广播到浏览器的一条线缆消息（三种频道：harness / loop / ui） */
type WireMessage =
  | { readonly ch: 'harness'; readonly event: HarnessEvent }
  | { readonly ch: 'loop'; readonly kind: LoopEvent['type']; readonly event: LoopEvent }
  | { readonly ch: 'loop'; readonly kind: 'command_text'; readonly text: string }
  | UiNotice;

interface WireEntry {
  readonly n: number;
  readonly json: string;
}

let wireSeq = 0;
const wire: WireEntry[] = [];
const clients = new Set<ServerResponse>();

/**
 * 广播一条消息：编号（全局单调）→ 序列化一次 → 入回放缓冲 → 推给全部
 * 在线客户端。两个通道（bus 订阅者 / runQuery 循环）共用本函数——到达
 * 顺序即线缆顺序。
 */
function broadcast(message: WireMessage): void {
  const n = ++wireSeq;
  const json = JSON.stringify({ n, at: Date.now(), ...message });
  wire.push({ n, json });
  if (wire.length > WIRE_LIMIT) wire.splice(0, wire.length - WIRE_LIMIT);
  for (const client of clients) {
    try {
      client.write(`data: ${json}\n\n`);
    } catch {
      clients.delete(client); // 断连竞态兜底（正常路径由 'close' 事件清理）
    }
  }
}

// ===========================================================================
// §3 应用装配与权限确认桥
// ===========================================================================

let app: CliApp;
let unsubscribeBus: () => void = () => {};

/** 当前 Provider 元数据（demo 为初值；启动时若环境已配置真实模型则替换） */
let providerInfo: ProviderInfo = { kind: 'demo', label: '离线演示', hasApiKey: false };

/**
 * 真实模式参数（内存态——key 不落盘、不入日志、不回显）。
 * null = 演示模式；非 null = 真实模式（bootApp 依此选 Provider 与 config）。
 */
let realConfig: RealProviderConfig | null = null;

/**
 * 当前会话 id：重建装配（切换 Provider / reset）时的接力棒。
 *   - 切换 Provider：保留（同一会话继续聊——历史在库里，换模型可对比）；
 *   - reset：置空（下次 bootApp 生成新会话）。
 */
let currentSessionId: string | undefined;

/**
 * 权限模式跨重建接力棒（切换 Provider / reset 都保留——模式是进程的
 * 运行姿态，不是某次会话的属性）。重建前从旧实例读回，bootApp 时传给
 * 新实例；运行期真相始终在 app.permissionMode.mode（本变量仅作接力）。
 */
let permissionModeSnapshot: PermissionMode = defaultConfig.permission.mode;

interface PendingConfirm {
  readonly settle: (approved: boolean, reason: 'user' | 'timeout') => void;
}

let pendingConfirm: PendingConfirm | null = null;

/**
 * 权限确认桥：ConfirmHandler（PermissionGate → 依赖倒置注入点）的 HTTP 化身。
 * 时序：PermissionGate 决策链走到 confirm → 本函数被调用 → SSE 推横幅 →
 * 用户点按 → POST /api/confirm 兑现。工具串行执行保证同一时刻至多一个
 * 待决确认；若出现并列（上一轮桥未收尾的异常竞态）直接拒绝兜底。
 */
const confirmBridge: ConfirmHandler = (request) =>
  new Promise<boolean>((resolve) => {
    if (pendingConfirm !== null) {
      resolve(false);
      return;
    }
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (approved: boolean, reason: 'user' | 'timeout'): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      pendingConfirm = null;
      broadcast({ ch: 'ui', type: 'permission_settled', approved, reason });
      resolve(approved);
    };
    timer = setTimeout(() => {
      settle(false, 'timeout');
    }, CONFIRM_TIMEOUT_MS);
    pendingConfirm = { settle };
    broadcast({
      ch: 'ui',
      type: 'permission_prompt',
      toolName: request.toolName,
      risk: request.risk,
      input: request.input,
    });
  });

/**
 * 装配（或重装）应用：与 CLI 同库同构，唯一差异 = 确认通道换成浏览器桥。
 * Provider 与 config 按 realConfig 分流：
 *   - 演示：FakeProvider + 缺省配置（离线确定性——与此前行为完全一致）；
 *   - 真实：OpenAICompatibleProvider + defaultModel 覆盖（模型名随配置走，
 *     事件流里的 llm_request/llm_response.model 与成本统计因此是真实的）。
 */
function bootApp(): void {
  const config =
    realConfig === null
      ? defineConfig()
      : defineConfig({ llm: { defaultModel: realConfig.model, requestTimeoutMs: 120_000 } });
  const provider =
    realConfig === null
      ? createDemoProvider({ chunkDelayMs: 6 }) // 分片延迟压缩到 6ms：网页观察节奏更快
      : new OpenAICompatibleProvider({ apiKey: realConfig.apiKey, baseUrl: realConfig.baseUrl });
  const cfg = realConfig; // 局部快照：闭包内保留非空收窄

  app = createCliApp({
    dbPath: resolveStorePath('data/web.db'),
    config,
    provider,
    // 子代理：真实模式跟随主世界；演示模式保持缺省（子世界演示规则）
    subagentProviderFactory:
      cfg === null
        ? undefined
        : () => new OpenAICompatibleProvider({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl }),
    ...(currentSessionId === undefined ? {} : { sessionId: currentSessionId }),
    confirm: confirmBridge,
    permissionMode: permissionModeSnapshot, // 跨重建接力（切 Provider / reset 不丢姿态）
  });
  currentSessionId = app.sessionId;
  // 通道①：HarnessEvent 全量订阅（Tracer 同款做法）——诊断流
  unsubscribeBus = app.bus.on('*', (event) => {
    broadcast({ ch: 'harness', event });
  });
}

/**
 * 热切换 Provider：停旧装配 → 换参数 → 起新装配。
 * 不碰内核一行——这正是「Provider 替换点唯一」的设计红利：
 * 更换模型 = 重新装配一次（毫秒级），会话与记忆都在库里，无缝延续。
 */
function applyProvider(
  next:
    | { readonly kind: 'demo' }
    | {
        readonly kind: 'real';
        readonly baseUrl: string;
        readonly model: string;
        readonly apiKey: string;
        readonly presetId: string;
      },
): void {
  permissionModeSnapshot = app.permissionMode.mode; // 接力棒：重建不丢运行姿态
  unsubscribeBus();
  app.dispose();
  if (next.kind === 'demo') {
    realConfig = null;
    providerInfo = { kind: 'demo', label: '离线演示', hasApiKey: false };
  } else {
    realConfig = { apiKey: next.apiKey, baseUrl: next.baseUrl, model: next.model };
    providerInfo = {
      kind: 'real',
      label: '真实 API',
      baseUrl: next.baseUrl,
      model: next.model,
      hasApiKey: next.apiKey !== '',
      presetId: next.presetId,
    };
  }
  bootApp();
  broadcast({ ch: 'ui', type: 'provider_changed', provider: providerInfo });
}

/**
 * 连通测试（不改变当前 Provider——纯探测）：
 *   路径 1：GET /models（无费用；不给模型名也能测）；
 *   路径 2：/models 不可用时降级为最小对话请求（需要模型名——验证真实对话能力）。
 * 15s 超时：探测要快速失败。
 */
async function testProviderConnection(
  baseUrl: string,
  model: string,
  apiKey: string,
): Promise<Record<string, unknown>> {
  const tester = new OpenAICompatibleProvider({ apiKey, baseUrl, timeoutMs: 15_000 });
  try {
    const models = await tester.listModels();
    return { ok: true, mode: 'models', models };
  } catch (modelsError) {
    if (model === '') {
      return {
        ok: false,
        mode: 'models',
        error: describeError(modelsError),
        hint: '该服务未实现 /models——请填写模型名后重试（将改用最小对话请求验证）',
      };
    }
    try {
      const response = await tester.complete({
        model,
        messages: [userMessage('请只回复两个字：正常')],
        maxOutputTokens: 24,
      });
      return { ok: true, mode: 'chat', reply: response.message.content, usage: response.usage };
    } catch (chatError) {
      return { ok: false, mode: 'chat', error: describeError(chatError) };
    }
  }
}

// ===========================================================================
// §4 query 运行器（单飞锁 + 双通道合流）
// ===========================================================================

interface ActiveQuery {
  readonly controller: AbortController;
}

let activeQuery: ActiveQuery | null = null;

/**
 * 执行一轮输入：handleLine 是「芯」（一行 → CliOutput 流），本函数是网页
 * 壳对它的消费方式——循环事件转广播（通道②），命令输出同样入 wire。
 * 致命异常不会击穿服务器：捕获 → query_error 通知（与 repl 的「壳负责
 * 显示与续命」契约一致）。
 */
async function runQuery(input: string): Promise<void> {
  const controller = new AbortController();
  activeQuery = { controller };
  broadcast({ ch: 'ui', type: 'query_submitted', input });
  let ok = true;
  try {
    for await (const output of app.handleLine(input, controller.signal)) {
      if (output.kind === 'command') {
        broadcast({ ch: 'loop', kind: 'command_text', text: output.text });
      } else {
        broadcast({ ch: 'loop', kind: output.event.type, event: output.event });
      }
    }
  } catch (error) {
    ok = false;
    broadcast({ ch: 'ui', type: 'query_error', message: describeError(error) });
  } finally {
    activeQuery = null;
    broadcast({ ch: 'ui', type: 'query_done', ok });
  }
}

// ===========================================================================
// §5 HTTP 路由
// ===========================================================================

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

/** 宽松字符串提取（请求体字段可能是任意 JSON 类型） */
function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('请求体必须是 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

/**
 * SSE 连接三连拍（顺序有讲究）：
 *   1. hello 快照（命名事件，不占 n 编号）——会话身份与忙闲的即视图；
 *   2. wire 全量重放（**同步循环**——与实时推送不会交叉，顺序安全）；
 *   3. 加入实时广播集合。
 * 浏览器据此可「刷新即重看」：本地按 n 去重，重连拿到重复前缀也无害。
 */
function openStream(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const session = app.manager.getSession(app.sessionId);
  res.write(
    `event: hello\ndata: ${JSON.stringify({
      sessionId: app.sessionId,
      state: session?.state ?? null,
      resumeReport: app.resumeReport ?? null,
      busy: activeQuery !== null,
      wireLength: wire.length,
      provider: providerInfo,
      permissionMode: app.permissionMode.mode,
      permissionModeDescription: describePermissionMode(app.permissionMode.mode),
    })}\n\n`,
  );
  for (const entry of wire) res.write(`data: ${entry.json}\n\n`);
  clients.add(res);
  res.on('close', () => {
    clients.delete(res);
  });
}

async function serveStatic(path: string, res: ServerResponse): Promise<void> {
  const name = STATIC_FILES.get(path);
  if (name === undefined) {
    sendJson(res, 404, { error: `未知路径：${path}` });
    return;
  }
  try {
    const data = await readFile(join(WEB_ROOT, name));
    res.writeHead(200, {
      'Content-Type': MIME[extname(name)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: `静态资源缺失：web/${name}` });
  }
}

/** 会话快照（GET /api/session；hello 是其富化版） */
function sessionSnapshot(): Record<string, unknown> {
  const session = app.manager.getSession(app.sessionId);
  return {
    sessionId: app.sessionId,
    state: session?.state ?? null,
    busy: activeQuery !== null,
    wireLength: wire.length,
    wireSeq,
    provider: providerInfo,
    permissionMode: app.permissionMode.mode,
    permissionModeDescription: describePermissionMode(app.permissionMode.mode),
  };
}

/**
 * 新会话：卸载旧 app（dispose 幂等）→ 清空 wire（新的观察起点）→ 重建。
 * 同库不同会话 = 「跨会话记忆」演示的正规路径（记忆存库、不随会话走）。
 */
function resetApp(): void {
  permissionModeSnapshot = app.permissionMode.mode; // 接力棒（模式与「新会话」无关）
  unsubscribeBus();
  app.dispose();
  wire.length = 0;
  currentSessionId = undefined; // 与「切换 Provider」的唯一差别：新会话
  bootApp();
  broadcast({ ch: 'ui', type: 'reset', sessionId: app.sessionId });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  const path = url.pathname;

  if (req.method === 'GET') {
    if (STATIC_FILES.has(path)) {
      await serveStatic(path, res);
      return;
    }
    if (path === '/api/stream') {
      openStream(res);
      return;
    }
    if (path === '/api/session') {
      sendJson(res, 200, sessionSnapshot());
      return;
    }
    if (path === '/api/provider') {
      // 当前 Provider 元数据 + 预设表（设置面板的「自由选择」数据源；
      // key 原文永不回传——只有 hasApiKey 布尔）
      sendJson(res, 200, { provider: providerInfo, presets: OPENAI_COMPATIBLE_PRESETS });
      return;
    }
    if (path === '/api/permission-mode') {
      // 只读视图：模式 + 描述 + 可选值表（展示文案与 CLI 同源——不前端重写）
      sendJson(res, 200, {
        mode: app.permissionMode.mode,
        description: describePermissionMode(app.permissionMode.mode),
        modes: PERMISSION_MODES,
      });
      return;
    }
  }

  if (req.method === 'POST') {
    if (path === '/api/query') {
      const body = await readJson(req);
      const input = typeof body['input'] === 'string' ? body['input'] : '';
      if (input.trim() === '') {
        sendJson(res, 400, { error: 'input 不能为空' });
        return;
      }
      if (activeQuery !== null) {
        sendJson(res, 409, { error: '已有查询在运行（单飞锁）——先中断或等待完成', busy: true });
        return;
      }
      sendJson(res, 202, { ok: true }); // 受理确认；事件经 SSE 流出
      void runQuery(input);
      return;
    }
    if (path === '/api/abort') {
      const busy = activeQuery !== null;
      activeQuery?.controller.abort();
      sendJson(res, 200, { ok: busy });
      return;
    }
    if (path === '/api/confirm') {
      const body = await readJson(req);
      if (pendingConfirm === null) {
        sendJson(res, 200, { ok: false, reason: '当前没有待决的权限确认' });
        return;
      }
      pendingConfirm.settle(body['approve'] === true, 'user');
      sendJson(res, 200, { ok: true });
      return;
    }
    if (path === '/api/permission-mode') {
      // 切换模式（与查询并发安全：控制器读写在每次 check 时取最新值，无需单飞锁）
      const body = await readJson(req);
      const parsed = typeof body['mode'] === 'string' ? parsePermissionMode(body['mode']) : undefined;
      if (parsed === undefined) {
        sendJson(res, 400, {
          error: `mode 必须是 ${PERMISSION_MODES.join(' / ')} 之一（收到 ${JSON.stringify(body['mode'])}）`,
        });
        return;
      }
      app.permissionMode.setMode(parsed);
      broadcast({
        ch: 'ui',
        type: 'permission_mode_changed',
        mode: parsed,
        description: describePermissionMode(parsed),
      }); // 多客户端同步（描述与 CLI 同源）
      sendJson(res, 200, { ok: true, mode: parsed, description: describePermissionMode(parsed) });
      return;
    }
    if (path === '/api/provider') {
      if (activeQuery !== null) {
        sendJson(res, 409, { error: '查询进行中——先中断（POST /api/abort）再切换模型' });
        return;
      }
      const body = await readJson(req);
      const kind = body['kind'];
      if (kind === 'demo') {
        applyProvider({ kind: 'demo' });
        sendJson(res, 200, { ok: true, provider: providerInfo });
        return;
      }
      if (kind === 'real') {
        const baseUrl = stringOf(body['baseUrl']).trim();
        const model = stringOf(body['model']).trim();
        const apiKey = stringOf(body['apiKey']).trim();
        const presetId = stringOf(body['presetId']) || 'custom';
        if (baseUrl === '') {
          sendJson(res, 400, { error: 'baseUrl 不能为空' });
          return;
        }
        if (!/^https?:\/\//.test(baseUrl)) {
          sendJson(res, 400, { error: 'baseUrl 必须以 http:// 或 https:// 开头' });
          return;
        }
        if (model === '') {
          sendJson(res, 400, { error: 'model 不能为空（真实模式需要明确的模型名）' });
          return;
        }
        applyProvider({ kind: 'real', baseUrl, model, apiKey, presetId });
        sendJson(res, 200, { ok: true, provider: providerInfo });
        return;
      }
      sendJson(res, 400, { error: "kind 必须是 'demo' 或 'real'" });
      return;
    }
    if (path === '/api/provider/test') {
      const body = await readJson(req);
      const baseUrl = stringOf(body['baseUrl']).trim();
      const model = stringOf(body['model']).trim();
      const apiKey = stringOf(body['apiKey']).trim();
      if (baseUrl === '') {
        sendJson(res, 400, { error: 'baseUrl 不能为空' });
        return;
      }
      if (!/^https?:\/\//.test(baseUrl)) {
        sendJson(res, 400, { error: 'baseUrl 必须以 http:// 或 https:// 开头' });
        return;
      }
      const startedAt = Date.now();
      const result = await testProviderConnection(baseUrl, model, apiKey);
      sendJson(res, 200, { ...result, baseUrl, latencyMs: Date.now() - startedAt });
      return;
    }
    if (path === '/api/reset') {
      if (activeQuery !== null) {
        sendJson(res, 409, { error: '查询进行中——先中断（POST /api/abort）再重置' });
        return;
      }
      resetApp();
      sendJson(res, 200, { ok: true, sessionId: app.sessionId });
      return;
    }
  }

  sendJson(res, 404, { error: `未知路径：${req.method} ${path}` });
}

// ===========================================================================
// §6 启动与优雅退出
// ===========================================================================

// 启动缺省：环境变量 / .env 若有真实模型配置 → 直接以真实模式起步；
// 否则演示模式（网页设置面板随时可热切换）
const envConfig = resolveRealProviderConfig();
if (envConfig !== undefined) {
  realConfig = envConfig;
  providerInfo = {
    kind: 'real',
    label: '真实 API',
    baseUrl: envConfig.baseUrl,
    model: envConfig.model,
    hasApiKey: envConfig.apiKey !== '',
    presetId: 'env',
  };
}

bootApp();

const server = createServer((req, res) => {
  void handleRequest(req, res).catch((error: unknown) => {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({ error: describeError(error) }));
  });
});

const pinger = setInterval(() => {
  for (const client of clients) client.write(': ping\n\n');
}, PING_INTERVAL_MS);

function shutdown(): void {
  clearInterval(pinger);
  for (const client of clients) client.end();
  unsubscribeBus();
  app.dispose();
  server.close(() => {
    process.exit(0);
  });
  // 兜底强退：极端情况下 open 连接拖住 close 回调
  setTimeout(() => {
    process.exit(0);
  }, 1_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// 端口占用（EADDRINUSE）等监听错误的友好退出：默认行为是抛一个裸异常栈，
// 对「另一个控制台还在跑」这种最常见的本地场景毫无可读性
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`\n✗ 端口 ${PORT} 已被占用——另一个网页控制台可能仍在运行。`);
    console.error('  处理：关闭旧进程，或用 HARNESS_WEB_PORT=<其他端口> 重新启动。');
  } else {
    console.error(`\n✗ 网页控制台启动失败：${describeError(error)}`);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('harness-lab 网页控制台（第四条壳：HTTP + SSE）');
  console.log(`  地址    http://${HOST}:${PORT}`);
  console.log('  数据    data/web.db（与 CLI 同库同构：会话 + 记忆共享一个 SQLite）');
  console.log(
    providerInfo.kind === 'demo'
      ? '  模型    演示规则 Provider（离线确定性；chunkDelayMs=6）'
      : `  模型    真实 API：${providerInfo.model} @ ${providerInfo.baseUrl}`,
  );
  console.log(
    `  权限    ${app.permissionMode.mode}—— ${describePermissionMode(app.permissionMode.mode)}（页面顶栏可切换）`,
  );
  console.log('  设置    页面顶栏「服务设置」：预设服务商 / 自定义 URL / 连通测试');
  console.log('  提示    页面底部播放条可「从头回放 / 单步 / 变速」观察整条主链路');
  console.log('  Ctrl+C  退出');
  console.log('');
});
