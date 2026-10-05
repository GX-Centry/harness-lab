/**
 * OpenAICompatibleProvider 单元测试 —— 用本地 http 服务器模拟 OpenAI 兼容
 * 线路（SSE 分片 / usage 末块 / 错误状态码），**不触碰任何真实 API**。
 *
 * 锚定的决策（对应实现文件头的协议六要点）：
 *   - SSE 解析：data: 行翻译 / [DONE] 终止 / 非 data 行静默跳过；
 *   - tool_calls 按 delta.index 记账：id/name 迟到时参数分片先缓冲、开闸后补发；
 *   - usage 优先取末块，缺失或 null 时近似兜底（DeepSeek 分片携带 "usage":null）；
 *   - HTTP 错误映射：401/404 → input_error（不可重试）、429 → rate_limit_error、
 *     5xx → provider_error，且错误详情透传；
 *   - 空响应防御：HTTP 200 但没有任何合法 chunk → provider_error（引导查 baseUrl）；
 *   - 请求侧映射：assistant.toolCalls → tool_calls（argsRaw 透传、空 content → null）、
 *     tool → { role:'tool', tool_call_id }；空 key 不发 Authorization 头；
 *   - 取消与超时可区分：用户取消 → AbortError（控制流），超时 → timeout_error。
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BASE_URL, OpenAICompatibleProvider } from '../../src/llm/openai-compatible-provider.ts';
import { assistantMessage, toolMessage, userMessage } from '../../src/types.ts';
import type { StreamEvent } from '../../src/types.ts';

const REQ = { model: 'test-model', messages: [userMessage('你好')] };

async function collect(iter: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

/** 捕获到的请求（断言「发给线路的请求」的抓手） */
interface Captured {
  readonly url: string;
  readonly body: string;
  readonly auth: string | undefined;
}

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

/** 起一个临时本地 HTTP 服务（随机端口），每用例独立开合（并行安全） */
async function withServer(
  handler: Handler,
  fn: (baseUrl: string, captured: Captured[]) => Promise<void>,
): Promise<void> {
  const captured: Captured[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (piece: string) => {
      body += piece;
    });
    req.on('end', () => {
      captured.push({ url: req.url ?? '', body, auth: req.headers.authorization });
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}/v1`, captured);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** 发送一段 SSE（chunk 数组 → data: 行；末尾 [DONE]） */
function sendSse(res: ServerResponse, chunks: readonly unknown[]): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

/** 捕获一次拒绝的错误形状（替代裸 rejects，便于继续断言 message） */
async function expectRejection(
  fn: () => Promise<unknown>,
): Promise<{ code?: string; retryable?: boolean; message: string }> {
  try {
    await fn();
  } catch (error) {
    const e = error as { code?: string; retryable?: boolean; message?: string };
    return { code: e.code, retryable: e.retryable, message: e.message ?? '' };
  }
  throw new Error('预期抛出错误，但调用成功了');
}

describe('OpenAICompatibleProvider', () => {
  it('流式文本：data 行翻译 → usage 末块 → [DONE] 收尾', async () => {
    await withServer(
      (_req, res) => {
        sendSse(res, [
          { choices: [{ index: 0, delta: { content: '你好' }, finish_reason: null }] },
          { choices: [{ index: 0, delta: { content: '世界' }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
          { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
        ]);
      },
      async (baseUrl, captured) => {
        const provider = new OpenAICompatibleProvider({ apiKey: 'k', baseUrl });
        const events = await collect(provider.stream(REQ));
        expect(events).toEqual([
          { type: 'text_delta', text: '你好' },
          { type: 'text_delta', text: '世界' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } },
        ]);
        // 请求侧契约：URL / 流式开关 / usage 声明 / 鉴权头 / 消息映射
        expect(captured[0]?.url).toBe('/v1/chat/completions');
        expect(captured[0]?.auth).toBe('Bearer k');
        const sent = JSON.parse(captured[0]?.body ?? '{}') as Record<string, unknown>;
        expect(sent['stream']).toBe(true);
        expect(sent['stream_options']).toEqual({ include_usage: true });
        expect(sent['messages']).toEqual([{ role: 'user', content: '你好' }]);
      },
    );
  });

  it('tool_calls：id/name 迟到 → 参数分片先缓冲，开闸后按序补发', async () => {
    await withServer(
      (_req, res) => {
        sendSse(res, [
          // 首块只有 arguments（id/name 未出现——部分网关的发射顺序）
          {
            choices: [
              { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"expr' } }] }, finish_reason: null },
            ],
          },
          // 第二块补上 id/name → 此刻才开闸（start + 补发缓冲分片）
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call_1', type: 'function', function: { name: 'calculator', arguments: '' } },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [
              { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'ession":"1+1"}' } }] }, finish_reason: null },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        ]);
      },
      async (baseUrl, captured) => {
        const provider = new OpenAICompatibleProvider({ apiKey: '', baseUrl });
        const events = await collect(provider.stream(REQ));
        expect(events).toEqual([
          { type: 'tool_call_start', id: 'call_1', name: 'calculator' },
          { type: 'tool_call_delta', id: 'call_1', argsDelta: '{"expr' },
          { type: 'tool_call_delta', id: 'call_1', argsDelta: 'ession":"1+1"}' },
          { type: 'tool_call_end', id: 'call_1' },
          { type: 'message_end', stopReason: 'tool_use', usage: expect.anything() },
        ]);
        // 空 key = 无鉴权服务：不发 Authorization 头
        expect(captured[0]?.auth).toBeUndefined();

        // complete 与 stream 严格一致：组装后可整体 parse
        const response = await provider.complete(REQ);
        expect(response.stopReason).toBe('tool_use');
        expect(response.message.toolCalls?.[0]).toMatchObject({
          id: 'call_1',
          name: 'calculator',
          args: { expression: '1+1' },
          argsRaw: '{"expression":"1+1"}',
        });
      },
    );
  });

  it('usage 缺失 → 近似兜底（不发 usage 末块的兼容服务）', async () => {
    await withServer(
      (_req, res) => {
        sendSse(res, [{ choices: [{ index: 0, delta: { content: '你好世界' }, finish_reason: 'stop' }] }]);
      },
      async (baseUrl) => {
        const provider = new OpenAICompatibleProvider({ apiKey: '', baseUrl });
        const events = await collect(provider.stream(REQ));
        const end = events.at(-1);
        expect(end?.type).toBe('message_end');
        if (end?.type === 'message_end') {
          expect(end.usage.inputTokens).toBeGreaterThan(0);
          expect(end.usage.outputTokens).toBeGreaterThan(0);
        }
      },
    );
  });

  it('usage:null 分片（DeepSeek 流式行为）不崩溃 → 末块真实 usage 正常捕获', async () => {
    await withServer(
      (_req, res) => {
        sendSse(res, [
          { choices: [{ index: 0, delta: { content: '你好' }, finish_reason: null }], usage: null },
          { choices: [{ index: 0, delta: { content: '世界' }, finish_reason: 'stop' }], usage: null },
          { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
        ]);
      },
      async (baseUrl) => {
        const provider = new OpenAICompatibleProvider({ apiKey: '', baseUrl });
        const events = await collect(provider.stream(REQ));
        expect(events).toEqual([
          { type: 'text_delta', text: '你好' },
          { type: 'text_delta', text: '世界' },
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } },
        ]);
      },
    );
  });

  it('全部分片 usage:null → 与缺失等价：近似兜底', async () => {
    await withServer(
      (_req, res) => {
        sendSse(res, [
          { choices: [{ index: 0, delta: { content: '你好世界' }, finish_reason: 'stop' }], usage: null },
          { choices: [], usage: null },
        ]);
      },
      async (baseUrl) => {
        const provider = new OpenAICompatibleProvider({ apiKey: '', baseUrl });
        const events = await collect(provider.stream(REQ));
        const end = events.at(-1);
        expect(end?.type).toBe('message_end');
        if (end?.type === 'message_end') {
          expect(end.usage.inputTokens).toBeGreaterThan(0);
          expect(end.usage.outputTokens).toBeGreaterThan(0);
        }
      },
    );
  });

  it('HTTP 错误映射：401/404 → input_error（不可重试）；429 → rate_limit_error；5xx → provider_error', async () => {
    const cases = [
      { status: 401, code: 'input_error', retryable: false, hint: 'API key' },
      { status: 404, code: 'input_error', retryable: false, hint: 'baseUrl' },
      { status: 429, code: 'rate_limit_error', retryable: true, hint: '' },
      { status: 500, code: 'provider_error', retryable: true, hint: '' },
    ] as const;
    for (const c of cases) {
      await withServer(
        (_req, res) => {
          sendJson(res, c.status, { error: { message: `boom-${c.status}` } });
        },
        async (baseUrl) => {
          const provider = new OpenAICompatibleProvider({ apiKey: 'k', baseUrl });
          const error = await expectRejection(() => provider.complete(REQ));
          expect(error).toMatchObject({ code: c.code, retryable: c.retryable });
          expect(error.message).toContain(`boom-${c.status}`); // 错误详情透传
          if (c.hint !== '') expect(error.message).toContain(c.hint); // 引导语
        },
      );
    }
  });

  it('空响应防御：HTTP 200 但无合法 chunk → provider_error（引导检查 baseUrl）', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html>这不是 OpenAI 端点</html>');
      },
      async (baseUrl) => {
        const provider = new OpenAICompatibleProvider({ apiKey: '', baseUrl });
        const error = await expectRejection(() => provider.complete(REQ));
        expect(error.code).toBe('provider_error');
        expect(error.message).toContain('OpenAI 兼容端点');
      },
    );
  });

  it('listModels：GET /models → id 列表（缺失 id 的条目被过滤）', async () => {
    await withServer(
      (_req, res) => {
        sendJson(res, 200, { object: 'list', data: [{ id: 'mock-chat' }, { id: 'mock-reasoner' }, { object: 'model' }] });
      },
      async (baseUrl, captured) => {
        const provider = new OpenAICompatibleProvider({ apiKey: '', baseUrl });
        await expect(provider.listModels()).resolves.toEqual(['mock-chat', 'mock-reasoner']);
        expect(captured[0]?.url).toBe('/v1/models');
      },
    );
  });

  it('请求侧映射：assistant.toolCalls → tool_calls（argsRaw 透传、空 content → null）；tool → tool_call_id', async () => {
    await withServer(
      (_req, res) => {
        sendSse(res, [{ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }]);
      },
      async (baseUrl, captured) => {
        const provider = new OpenAICompatibleProvider({ apiKey: 'k', baseUrl });
        await provider.complete({
          model: 'm',
          messages: [
            { role: 'system', content: '你是助手' },
            assistantMessage('', [
              { id: 'c1', name: 'calculator', args: { expression: '1+1' }, argsRaw: '{"expression":"1+1"}' },
            ]),
            toolMessage('c1', 'calculator', '2'),
          ],
          tools: [{ name: 'calculator', description: '算术', inputSchema: { type: 'object' } }],
        });
        const sent = JSON.parse(captured[0]?.body ?? '{}') as { messages?: unknown[]; tools?: unknown[] };
        expect(sent.messages).toEqual([
          { role: 'system', content: '你是助手' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'calculator', arguments: '{"expression":"1+1"}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'c1', content: '2' },
        ]);
        expect(sent.tools).toEqual([
          { type: 'function', function: { name: 'calculator', description: '算术', parameters: { type: 'object' } } },
        ]);
      },
    );
  });

  it('baseUrl 规范化：去尾斜杠 / 误填完整端点回退 / 空回退缺省', () => {
    expect(new OpenAICompatibleProvider({ apiKey: '', baseUrl: 'https://api.x.com/v1/' }).endpoint).toBe(
      'https://api.x.com/v1',
    );
    expect(
      new OpenAICompatibleProvider({ apiKey: '', baseUrl: 'https://api.x.com/v1/chat/completions' }).endpoint,
    ).toBe('https://api.x.com/v1');
    expect(new OpenAICompatibleProvider({ apiKey: '' }).endpoint).toBe(DEFAULT_BASE_URL);
  });

  it('用户取消 → AbortError（取消是控制流，与超时可区分）', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = new OpenAICompatibleProvider({ apiKey: '', baseUrl: 'http://127.0.0.1:9/v1', timeoutMs: 3_000 });
    await expect(provider.complete({ ...REQ, signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('超时 → timeout_error（合成信号中 timeout 先触发）', async () => {
    await withServer(
      (_req, res) => {
        // 永不响应；provider 超时后客户端 abort，连接随销毁
        setTimeout(() => {
          if (!res.writableEnded) res.end();
        }, 500);
      },
      async (baseUrl) => {
        const provider = new OpenAICompatibleProvider({ apiKey: '', baseUrl, timeoutMs: 80 });
        const error = await expectRejection(() => provider.complete(REQ));
        expect(error.code).toBe('timeout_error');
      },
    );
  });
});
