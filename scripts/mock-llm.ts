/**
 * 本地 OpenAI 兼容 mock 服务 —— 「自定义 URL 连通测试」的内置靶子。
 *
 * == 为什么需要它 ==
 * 网页设置面板支持「自定义 URL + 连通测试」。在没有真实 API key 时，
 * 拿什么当测试目标？本文件就是答案：一个跑在本机的、说 OpenAI 协议的
 * 迷你服务——真实 key 到达之前，它让你先走通「设置 → 测试 → 应用 →
 * 真实协议对话」的完整链路（链路里除模型本身之外的一切都是真的）。
 *
 * == 协议面（Chat Completions 的最小可用子集）==
 *   GET  /v1/models             模型列表（连通测试的免费路径）
 *   POST /v1/chat/completions   流式 SSE（含 usage 末块）/ 非流式 JSON
 *
 * == mock 的「智能」：确定性规则（不是 AI，是状态机）==
 *   1. 最后一条是 user、请求声明了 skill_ 前缀工具（技能的模型面暴露面）
 *      且文本提到 技能/skill/报告/report → tool_call(skill_xxx, {input})——
 *      驱动「模型调用技能」的完整链路（w18 技能进模型面的端到端靶子）；
 *   2. 最后一条是 user、请求声明了 calculator 工具、文本里有算式
 *      → tool_call(calculator, {expression})（参数按 OpenAI 协议分片发送）；
 *   3. 最后一条是 tool 结果 → 文本总结回合（把结果念出来——模拟「工具回写后
 *      模型收尾」；驱动 harness 的完整工具循环）；
 *   4. 其他 → 自我介绍文本。
 *
 * == 故障注入彩蛋（演示错误路径）==
 *   model=mock-500   请求直接 500（演示 provider_error / 重试判定）
 *   model=mock-401   请求直接 401（演示认证失败映射）
 *   model=mock-slow  分块间隔 1s（演示慢流与超时预算）
 *
 * 端口 HARNESS_MOCK_PORT（默认 8099）。零依赖（node:http）。
 * 启动：pnpm mock-llm
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 8099;
const CHUNK_DELAY_MS = 30; // 分块间隔（流式肉眼可见；mock-slow 覆盖为 1s）
const TEXT_CHUNK_SIZE = 4; // 文本分片大小（字符）

const parsedPort = Number(process.env['HARNESS_MOCK_PORT'] ?? '');
const PORT = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT;

const MOCK_TOOL_CALL_ID = 'call_mock_1';

// ===========================================================================
// §1 线路类型（只描述 mock 用到的字段）
// ===========================================================================

interface ChatMessage {
  readonly role: string;
  readonly content?: string | null;
}

interface ChatRequestBody {
  readonly model?: string;
  readonly messages?: readonly ChatMessage[];
  readonly tools?: ReadonlyArray<{ readonly function?: { readonly name?: string } }>;
  readonly stream?: boolean;
  readonly stream_options?: { readonly include_usage?: boolean };
}

/** 回合计划：mock 对一次请求的完整回应意图 */
type TurnPlan =
  | { readonly kind: 'tool'; readonly name: string; readonly argsJson: string; readonly text: string }
  | { readonly kind: 'text'; readonly text: string };

// ===========================================================================
// §2 回合决策（确定性规则）
// ===========================================================================

function hasCalculatorTool(body: ChatRequestBody): boolean {
  return (body.tools ?? []).some((t) => t.function?.name === 'calculator');
}

/** 请求里第一个技能工具（skill_ 前缀——w18 起技能会出现在模型面 tools 参数里） */
function firstSkillTool(body: ChatRequestBody): string | undefined {
  return (body.tools ?? []).find((t) => t.function?.name?.startsWith('skill_') === true)
    ?.function?.name;
}

function lastMessage(body: ChatRequestBody): ChatMessage | undefined {
  const messages = body.messages ?? [];
  return messages[messages.length - 1];
}

/** 从文本里抽最长算式片段（[数字与运算符] 且必须同时含数字和运算符） */
function extractExpression(text: string): string | undefined {
  const candidates = text.match(/[\d+\-*/(). ]+/g) ?? [];
  let best: string | undefined;
  for (const raw of candidates) {
    const trimmed = raw.trim();
    if (!/\d/.test(trimmed)) continue;
    if (!/[+\-*/]/.test(trimmed)) continue;
    if (best === undefined || trimmed.length > best.length) best = trimmed;
  }
  return best;
}

function planTurn(body: ChatRequestBody): TurnPlan {
  const last = lastMessage(body);

  // 规则 3：工具结果刚回来 → 收尾文本（把结果念出来）
  if (last?.role === 'tool') {
    const result = (last.content ?? '').slice(0, 120);
    return {
      kind: 'text',
      text: `（mock 模型）我已收到工具执行结果：${result}\n结论：任务完成——这是我对工具结果的最终总结回复。`,
    };
  }

  // 规则 1（w18）：技能触发——请求声明了 skill_ 前缀工具（技能的模型面暴露）
  // 且文本提到技能/报告 → 发起技能工具调用。输入取算式（若有）；无算式时
  // 省略 input 字段（技能自行回退默认输入——mock 不把自然语言当算式传进去）。
  if (last?.role === 'user') {
    const skillTool = firstSkillTool(body);
    if (skillTool !== undefined && /技能|skill|报告|report/i.test(last.content ?? '')) {
      const expression = extractExpression(last.content ?? '');
      return {
        kind: 'tool',
        name: skillTool,
        argsJson: expression === undefined ? '{}' : JSON.stringify({ input: expression }),
        text: '这个任务适合用技能完成——让我调用技能工具。',
      };
    }
  }

  // 规则 2：声明了 calculator 且有算式 → 发起工具调用
  if (last?.role === 'user' && hasCalculatorTool(body)) {
    const expression = extractExpression(last.content ?? '');
    if (expression !== undefined) {
      return {
        kind: 'tool',
        name: 'calculator',
        argsJson: JSON.stringify({ expression }),
        text: '让我用计算器工具算一下。',
      };
    }
  }

  // 规则 4：兜底自我介绍
  return {
    kind: 'text',
    text:
      '（mock 模型）你好！我是本地 OpenAI 兼容 mock 服务。' +
      '试试「帮我算 12*(3+4)」——如果请求里声明了 calculator 工具，我会发起一次真实的工具调用；' +
      '试试「用技能出个计算报告 21*2」——如果声明了 skill_ 前缀工具，我会改为调用技能工具；' +
      '工具结果回写后，我会再产出总结回复。',
  };
}

// ===========================================================================
// §3 事件发射（SSE / JSON）
// ===========================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 按 code point 切分（不切开 emoji 等代理对——与 FakeProvider 同一手法） */
function splitChunks(text: string, size: number): string[] {
  const chars = Array.from(text);
  const chunks: string[] = [];
  for (let i = 0; i < chars.length; i += size) {
    chunks.push(chars.slice(i, i + size).join(''));
  }
  return chunks;
}

function roughTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

function promptText(body: ChatRequestBody): string {
  return (body.messages ?? []).map((m) => m.content ?? '').join('\n');
}

function completionText(plan: TurnPlan): string {
  return plan.kind === 'tool' ? plan.text + plan.argsJson : plan.text;
}

function usageOf(body: ChatRequestBody, plan: TurnPlan): { prompt_tokens: number; completion_tokens: number } {
  return {
    prompt_tokens: roughTokens(promptText(body)),
    completion_tokens: roughTokens(completionText(plan)),
  };
}

/** SSE 发送器（写一行 data: 事件） */
function sendEvent(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/** 流式回合：文本分片 →（工具回合）调用分片 → finish_reason → usage → [DONE] */
async function streamTurn(
  res: ServerResponse,
  body: ChatRequestBody,
  plan: TurnPlan,
  delayMs: number,
): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const model = body.model ?? 'mock-chat';
  const base = { id: 'chatcmpl-mock', object: 'chat.completion.chunk', model };

  // 忠实复刻 DeepSeek：每个中间分片都携带 "usage":null——让消费方的
  // 「null 不得当有效 usage」防线始终处于被测试状态
  const text = plan.text;
  for (const piece of splitChunks(text, TEXT_CHUNK_SIZE)) {
    sendEvent(res, {
      ...base,
      usage: null,
      choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
    });
    await sleep(delayMs);
  }

  if (plan.kind === 'tool') {
    // 首块：id + name + 空 arguments（OpenAI 协议的首块形状）
    sendEvent(res, {
      ...base,
      usage: null,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: MOCK_TOOL_CALL_ID, type: 'function', function: { name: plan.name, arguments: '' } },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    await sleep(delayMs);
    // 后续块：仅 arguments 增量
    for (const piece of splitChunks(plan.argsJson, 6)) {
      sendEvent(res, {
        ...base,
        usage: null,
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] },
            finish_reason: null,
          },
        ],
      });
      await sleep(delayMs);
    }
  }

  sendEvent(res, {
    ...base,
    usage: null,
    choices: [{ index: 0, delta: {}, finish_reason: plan.kind === 'tool' ? 'tool_calls' : 'stop' }],
  });
  if (body.stream_options?.include_usage === true) {
    sendEvent(res, { ...base, choices: [], usage: usageOf(body, plan) });
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

/** 非流式回合：完整 JSON 响应 */
function sendJsonTurn(res: ServerResponse, body: ChatRequestBody, plan: TurnPlan): void {
  const model = body.model ?? 'mock-chat';
  const message =
    plan.kind === 'tool'
      ? {
          role: 'assistant',
          content: plan.text,
          tool_calls: [
            { id: MOCK_TOOL_CALL_ID, type: 'function', function: { name: plan.name, arguments: plan.argsJson } },
          ],
        }
      : { role: 'assistant', content: plan.text };
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(
    JSON.stringify({
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      model,
      choices: [{ index: 0, message, finish_reason: plan.kind === 'tool' ? 'tool_calls' : 'stop' }],
      usage: usageOf(body, plan),
    }),
  );
}

// ===========================================================================
// §4 HTTP 入口
// ===========================================================================

async function readBody(req: IncomingMessage): Promise<ChatRequestBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  return JSON.parse(text) as ChatRequestBody;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? '/').split('?')[0] ?? '/';

  // 连通测试路径：GET /v1/models
  if (req.method === 'GET' && path.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ object: 'list', data: MODEL_IDS.map((id) => ({ id, object: 'model' })) }));
    return;
  }

  if (req.method === 'POST' && path.endsWith('/chat/completions')) {
    const body = await readBody(req).catch(() => ({}) as ChatRequestBody);
    const model = body.model ?? '';
    console.log(`  ${req.method} ${path}  model=${model || '(未指定)'}  stream=${body.stream === true}`);

    // 故障注入彩蛋
    if (model === 'mock-401') {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { message: 'mock 故障注入：模拟 API key 无效' } }));
      return;
    }
    if (model === 'mock-500') {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { message: 'mock 故障注入：模拟服务端故障' } }));
      return;
    }

    const plan = planTurn(body);
    const delayMs = model === 'mock-slow' ? 1000 : CHUNK_DELAY_MS;
    if (body.stream === true) {
      await streamTurn(res, body, plan, delayMs);
    } else {
      sendJsonTurn(res, body, plan);
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: { message: `mock 只实现 /v1/models 与 /v1/chat/completions（收到 ${path}）` } }));
}

const MODEL_IDS = ['mock-chat', 'mock-reasoner'] as const;

const server = createServer((req, res) => {
  void handle(req, res).catch((error: unknown) => {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
  });
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('harness-lab mock LLM（本地 OpenAI 兼容服务）');
  console.log(`  端点    http://${HOST}:${PORT}/v1`);
  console.log(`  模型    ${MODEL_IDS.join(' / ')}（另有彩蛋 mock-500 / mock-401 / mock-slow）`);
  console.log('  用法    网页设置面板 → 自定义 → Base URL 填上面端点 → 测试连通');
  console.log('  Ctrl+C  退出');
  console.log('');
});
