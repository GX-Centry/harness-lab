/**
 * CLI 集成测试（w17）——「芯 / 壳分离」的可测性承诺的兑现。
 *
 * 覆盖矩阵：
 *   ① 芯（handleLine）：空行 / 斜杠命令拦截 / 对话闭环 / 持久化；
 *   ② 组装（createCliApp）：同 id 复用（幂等回归）/ continueLatest / 状态门控恢复；
 *   ③ 渲染（createCliRenderer）：流式混排 / 工具行 / 统计行 / 防御分支；
 *   ④ 演示规则（demo）：问候 / 计算 / 总结 / 子代理（规则模式的确定性）；
 *   ⑤ 确认通道（createReadlineConfirm）：回答语义 / 超时哨兵（悬挂回调清理）。
 *
 * 壳（repl/main）刻意不被测试：readline 交互与信号处理不可测——所有
 * 能被测的逻辑都在芯与渲染里（这正是分层的意义）。唯一触碰 readline 的
 * 是 §5：用 PassThrough 假流驱动真实 readline 实例（无 TTY 依赖）。
 *
 * 存储：默认 :memory:（零文件副作用）；跨 app 复用会话的场景用临时
 * 文件库（每次 mkdtempSync，afterAll 统一清理）。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { createCliApp } from '../../src/cli/app.ts';
import type { CliApp, CliOutput } from '../../src/cli/app.ts';
import { createDemoProvider, createSubagentDemoProvider } from '../../src/cli/demo.ts';
import { createCliRenderer } from '../../src/cli/render.ts';
import { createReadlineConfirm } from '../../src/cli/repl.ts';
import type { LoopEvent, LoopResult } from '../../src/kernel/agent-loop.ts';
import { FakeProvider } from '../../src/llm/fake-provider.ts';
import type { FakeTurn } from '../../src/llm/fake-provider.ts';
import type { ConfirmHandler, PermissionRequest } from '../../src/permission/gate.ts';
import { SessionStore } from '../../src/session/store.ts';
import { failedResult, okResult } from '../../src/types.ts';

// ---------------------------------------------------------------------------
// 测试装置
// ---------------------------------------------------------------------------

/** 缺省确认通道：自动批准（演示意图——与 --yes 同语义） */
const approveAll: ConfirmHandler = () => Promise.resolve(true);

function sig(): AbortSignal {
  return new AbortController().signal;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 临时文件库（跨 app 复用）；统一登记、afterAll 清理
const tempDirs: string[] = [];
function makeTempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-cli-'));
  tempDirs.push(dir);
  return join(dir, 'cli.db');
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

interface MakeAppOptions {
  readonly script?: readonly FakeTurn[];
  readonly dbPath?: string;
  readonly sessionId?: string;
  readonly continueLatest?: boolean;
  readonly confirm?: ConfirmHandler;
}

function makeApp(options: MakeAppOptions = {}): CliApp {
  return createCliApp({
    dbPath: options.dbPath ?? ':memory:',
    provider: new FakeProvider({ script: options.script ?? [] }),
    confirm: options.confirm ?? approveAll,
    sessionId: options.sessionId,
    continueLatest: options.continueLatest,
  });
}

/** 消费一整行的输出流 */
async function handle(app: CliApp, line: string): Promise<CliOutput[]> {
  const outputs: CliOutput[] = [];
  for await (const output of app.handleLine(line, sig())) outputs.push(output);
  return outputs;
}

/** 从输出流里筛出 loop 事件（command 输出天然被排除） */
function loopEvents(outputs: readonly CliOutput[]): LoopEvent[] {
  return outputs.flatMap((output) => (output.kind === 'loop' ? [output.event] : []));
}

function textDeltas(events: readonly LoopEvent[]): string {
  return events
    .filter((event): event is Extract<LoopEvent, { type: 'text_delta' }> => event.type === 'text_delta')
    .map((event) => event.text)
    .join('');
}

// ---------------------------------------------------------------------------
// §1 芯：handleLine
// ---------------------------------------------------------------------------

describe('§1 芯（handleLine）', () => {
  it('空行 / 纯空白：无任何输出', async () => {
    const app = makeApp({ script: [] });
    expect(await handle(app, '')).toEqual([]);
    expect(await handle(app, '   ')).toEqual([]);
    app.dispose();
  });

  it('斜杠命令在进模型之前被拦截：仅产出 command 输出', async () => {
    // 空脚本的 Provider：若命令漏进模型，会立刻 provider_error（异常或 loop 输出）
    const app = makeApp({ script: [] });
    const outputs = await handle(app, '/help');
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.kind).toBe('command');
    if (outputs[0]?.kind === 'command') expect(outputs[0].text).toContain('可用命令');
    app.dispose();
  });

  it('对话闭环：工具调用 → 总结 → completed 信封（事件流全链路）', async () => {
    const app = makeApp({
      script: [
        { text: '好，用计算器算一下。', toolCalls: [{ name: 'calculator', args: { expression: '21 * 2' } }] },
        { text: '结果是 42。' },
      ],
    });
    const outputs = await handle(app, '计算 21 * 2');
    const events = loopEvents(outputs);

    // 序列骨架：轮次开始 → … → 终态信封在最后
    expect(events[0]?.type).toBe('turn_started');
    expect(events.at(-1)?.type).toBe('completed');

    // 工具活动透传（含名称与成功结果）
    expect(events.find((event) => event.type === 'tool_started')).toMatchObject({
      name: 'calculator',
    });
    expect(events.find((event) => event.type === 'tool_finished')).toMatchObject({
      name: 'calculator',
      result: { ok: true },
    });

    // 文本增量拼接 = 两回合台词
    expect(textDeltas(events)).toBe('好，用计算器算一下。结果是 42。');

    // 终态信封：stopReason / turns / finalMessage
    const completed = events.at(-1);
    if (completed?.type === 'completed') {
      expect(completed.result.stopReason).toBe('completed');
      expect(completed.result.turns).toBe(2);
      expect(completed.result.finalMessage?.content).toBe('结果是 42。');
    }
    app.dispose();
  });

  it('会话持久化：query 后消息落盘、状态回 completed', async () => {
    const app = makeApp({ script: [{ text: '好的。' }] });
    await handle(app, '你好');
    const info = app.manager.getSession(app.sessionId);
    expect(info?.messageCount).toBeGreaterThan(0);
    expect(info?.state).toBe('completed');
    app.dispose();
  });
});

// ---------------------------------------------------------------------------
// §2 组装：createCliApp 的会话就位逻辑
// ---------------------------------------------------------------------------

describe('§2 组装（会话就位）', () => {
  it('同 id 再次启动不抛：装配层对 createSession 非幂等的防护（回归）', async () => {
    const dbPath = makeTempDbPath();
    const app1 = makeApp({ dbPath, sessionId: 'cli-fixed' });
    app1.dispose();

    // 修复前：createSession 重复 id 抛 input_error——这一行会挂
    const app2 = makeApp({ dbPath, sessionId: 'cli-fixed' });
    expect(app2.sessionId).toBe('cli-fixed');
    expect(app2.resumeReport).toBeUndefined(); // created 状态：无需恢复
    app2.dispose();
  });

  it('continueLatest：目标 = 最近活动的会话；库为空时回落为新建', async () => {
    const dbPath = makeTempDbPath();

    const appA = makeApp({ dbPath, sessionId: 'cli-a', script: [{ text: 'A 的回复' }] });
    await handle(appA, '你好');
    appA.dispose();
    await sleep(10); // 拉开 updatedAt（排序依据）

    const appB = makeApp({ dbPath, sessionId: 'cli-b', script: [{ text: 'B 的回复' }] });
    await handle(appB, '你好');
    appB.dispose();

    const appC = makeApp({ dbPath, continueLatest: true });
    expect(appC.sessionId).toBe('cli-b'); // 最近活动者胜出
    appC.dispose();

    // 空库回落：全新随机 id（cli- 前缀 + 8 位短码）
    const emptyDb = makeTempDbPath();
    const appD = makeApp({ dbPath: emptyDb, continueLatest: true });
    expect(appD.sessionId).toMatch(/^cli-[0-9a-f]{8}$/);
    appD.dispose();
  });

  it('状态门控恢复：interrupted + 检查点 → resumeReport，且恢复后可继续对话', async () => {
    const dbPath = makeTempDbPath();

    // 第一次进程：跑一轮带工具调用的对话（保证轮次边界产生检查点）
    const app1 = makeApp({
      dbPath,
      sessionId: 'cli-r',
      script: [
        { text: '用计算器。', toolCalls: [{ name: 'calculator', args: { expression: '1 + 1' } }] },
        { text: '结果是 2。' },
      ],
    });
    await handle(app1, '算一下 1+1');
    app1.dispose();

    // 直接对库做状态迁移：模拟「进程中断的残留」（绕过 manager 是刻意的——
    // 本测试要验证的是装配层对状态的**门控**，不是中断的产生过程）
    const store = new SessionStore(dbPath);
    store.updateState('cli-r', 'interrupted');
    store.close();

    // 第二次进程：同 id 启动 → 装配层识别 interrupted → 自动执行恢复流程
    const app2 = makeApp({ dbPath, sessionId: 'cli-r', script: [{ text: '恢复后继续。' }] });
    expect(app2.resumeReport).toBeDefined();
    expect(app2.resumeReport?.sessionId).toBe('cli-r');
    expect(app2.resumeReport?.filledToolCallIds).toEqual([]); // 正常完成：无待补位调用

    // 恢复后的会话可直接继续：新一轮 query 正常闭环
    const outputs = await handle(app2, '继续');
    expect(loopEvents(outputs).at(-1)?.type).toBe('completed');
    app2.dispose();
  });
});

// ---------------------------------------------------------------------------
// §3 渲染：createCliRenderer
// ---------------------------------------------------------------------------

function loop(event: LoopEvent): CliOutput {
  return { kind: 'loop', event };
}

function makeResult(over: Partial<LoopResult> = {}): LoopResult {
  return {
    stopReason: 'completed',
    turns: 1,
    usage: { inputTokens: 10, outputTokens: 5 },
    messages: [],
    finalMessage: undefined,
    ...over,
  };
}

/** 整段渲染（含 endTurn 收尾）→ 单串 */
function renderAll(outputs: readonly CliOutput[]): string {
  const chunks: string[] = [];
  const renderer = createCliRenderer((text) => chunks.push(text));
  for (const output of outputs) renderer.render(output);
  renderer.endTurn();
  return chunks.join('');
}

describe('§3 渲染（createCliRenderer）', () => {
  it('流式原地拼接 + 工具行换行隔离 + 终态统计行', () => {
    const text = renderAll([
      loop({ type: 'turn_started', turn: 1 }),
      loop({ type: 'text_delta', text: '你好' }),
      loop({ type: 'text_delta', text: '，世界' }),
      loop({ type: 'tool_started', toolCallId: 'c1', name: 'echo', args: { message: 'hi' } }),
      loop({ type: 'tool_finished', toolCallId: 'c1', name: 'echo', result: okResult('hi') }),
      loop({ type: 'text_delta', text: '结束。' }),
      loop({ type: 'completed', result: makeResult({ turns: 2 }) }),
    ]);
    expect(text).toBe(
      '你好，世界\n' + // 流式片段原地拼接；工具行前补换行
        '▸ echo({"message":"hi"})\n' + // 非闭合行 → 工具行独占一行
        '✓ echo → hi\n' +
        '结束。\n' + // 工具行已闭合 → 文本在新行开始
        '—— 2 轮 · ↑10 ↓5 tok\n',
    );
  });

  it('失败工具 → ✗；多行内容只取首行（单行纪律）', () => {
    const text = renderAll([
      loop({
        type: 'tool_finished',
        toolCallId: 'c1',
        name: 'calculator',
        result: failedResult('input_error', '除数为零', '除数为零（不能除以 0）\n补充说明行'),
      }),
    ]);
    expect(text).toBe('✗ calculator → 除数为零（不能除以 0）\n');
  });

  it('非正常终止的括注：max_turns / aborted', () => {
    expect(
      renderAll([loop({ type: 'completed', result: makeResult({ stopReason: 'max_turns' }) })]),
    ).toContain('（达到最大轮次）');
    expect(
      renderAll([loop({ type: 'completed', result: makeResult({ stopReason: 'aborted' }) })]),
    ).toContain('（已取消）');
  });

  it('command 输出整行；endTurn 收尾未闭合的流式行', () => {
    expect(renderAll([{ kind: 'command', text: '帮助文本' }])).toBe('帮助文本\n');
    expect(renderAll([loop({ type: 'text_delta', text: '半句' })])).toBe('半句\n');
  });

  it('防御分支：参数不可序列化 → 行内提示（渲染不崩）', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(renderAll([loop({ type: 'tool_started', toolCallId: 'c1', name: 'x', args: cyclic })])).toBe(
      '▸ x([参数无法序列化])\n',
    );
  });
});

// ---------------------------------------------------------------------------
// §4 演示规则（demo.ts）—— 规则模式的确定性
// ---------------------------------------------------------------------------

const REQ = (content: string): { model: string; messages: { role: 'user'; content: string }[] } => ({
  model: 'test',
  messages: [{ role: 'user', content }],
});

describe('§4 演示规则 Provider', () => {
  it('问候 → 引导文本（演示模式自介）', async () => {
    const provider = createDemoProvider();
    const r = await provider.complete(REQ('你好呀'));
    expect(r.message.content).toContain('演示模式');
    expect(r.message.toolCalls).toBeUndefined();
  });

  it('计算请求 → calculator 工具调用（表达式经启发式提取）', async () => {
    const provider = createDemoProvider();
    const r = await provider.complete(REQ('计算 12 * 8'));
    expect(r.stopReason).toBe('tool_use');
    expect(r.message.toolCalls?.[0]?.name).toBe('calculator');
    expect(r.message.toolCalls?.[0]?.args).toMatchObject({ expression: '12 * 8' });
  });

  it('工具结果回注（tail = tool）→ 总结回合，不再调工具', async () => {
    const provider = createDemoProvider();
    const r = await provider.complete({
      model: 'test',
      messages: [
        { role: 'user', content: '计算 12*8' },
        { role: 'tool', content: '96', toolCallId: 'c1', name: 'calculator' },
      ],
    } as never);
    expect(r.stopReason).toBe('end_turn');
    expect(r.message.content).toContain('结果是 96');
    expect(r.message.toolCalls).toBeUndefined();
  });

  it('未知输入 → 兜底规则（复述 + 引导，恒有应答）', async () => {
    const provider = createDemoProvider();
    const r = await provider.complete(REQ('随便说点什么'));
    expect(r.message.content).toContain('演示模式·确定性应答');
  });

  it('子代理 Provider：单回合定性输出（不派活、不自旋）', async () => {
    const provider = createSubagentDemoProvider();
    const r = await provider.complete(REQ('调研 X 问题'));
    expect(r.message.content).toContain('子代理');
    expect(r.message.toolCalls).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §5 确认通道（createReadlineConfirm）—— 回答语义与超时哨兵
// ---------------------------------------------------------------------------

function makeReadline(): { rl: ReturnType<typeof createInterface>; input: PassThrough } {
  const input = new PassThrough();
  const output = new PassThrough();
  const rl = createInterface({ input, output, terminal: false });
  return { rl, input };
}

const PERMISSION_REQUEST: PermissionRequest = {
  sessionId: 's',
  queryId: 'q',
  toolName: 'echo',
  risk: 'medium',
  input: {},
};

describe('§5 确认通道（readline）', () => {
  it('回答语义：Y → true；空回车 → false（fail-safe 默认）', async () => {
    const { rl, input } = makeReadline();
    const confirm = createReadlineConfirm(() => rl, 1_000);

    const first = confirm(PERMISSION_REQUEST);
    input.write('Y\n');
    await expect(first).resolves.toBe(true);

    const second = confirm(PERMISSION_REQUEST);
    input.write('\n');
    await expect(second).resolves.toBe(false);

    rl.close();
  });

  it('超时 → resolve(false)；哨兵清理悬挂回调（此后输入不被吞）', async () => {
    const { rl, input } = makeReadline();
    const lines: string[] = [];
    rl.on('line', (line) => lines.push(line));

    const confirm = createReadlineConfirm(() => rl, 40);
    await expect(confirm(PERMISSION_REQUEST)).resolves.toBe(false); // 超时拒绝

    // 哨兵已注入（内部 rl.write('\n')）——悬挂的 _questionCallback 应已被清掉：
    // 若未清理，这一行会被它截获（不产生 'line' 事件）
    input.write('hello\n');
    await sleep(20);
    expect(lines).toContain('hello');

    rl.close();
  });
});
