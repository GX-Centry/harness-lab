/**
 * placeholders 层测试：接口保留的「可对接性证明」。
 *
 * 本目录没有实现逻辑，测试要回答的是另外两个问题：
 *
 *  §1 零运行时资产——四个模块编译后全部是空模块（无任何运行时导出），
 *     形式化验证「删除本目录内核零影响」（ADR-010 的必要条件）；
 *
 *  §2-§5 形状可对接——每个接口写一个最小内存实现（编译通过 = 接口形状
 *     成立），并演示未来的接线点：MCP → 工具注册面、Broker → ConfirmHandler、
 *     STT → 输入层、Teams → 黑板/收件箱。这些测试**不替代实现**：解冻时
 *     真正的工程（JSON-RPC 客户端、HTTP/SSE 传输、音频管线、调度器）不在
 *     测试里预演——把形状证明与实现混为一谈才是对接口保留的误读。
 */

import { describe, expect, it } from 'vitest';
import type { ConfirmHandler, PermissionRequest } from '../../src/permission/gate.ts';
import type { RiskLevel } from '../../src/types.ts';
import * as mcp from '../../src/placeholders/mcp.ts';
import * as placeholdersIndex from '../../src/placeholders/index.ts';
import * as stt from '../../src/placeholders/stt.ts';
import * as teams from '../../src/placeholders/teams.ts';
import * as webSse from '../../src/placeholders/web-sse.ts';

// ===========================================================================
// §1 零运行时资产（「可整体删除」的形式化验证）
// ===========================================================================

describe('placeholders：零运行时资产', () => {
  it('四个模块与聚合出口编译后均为空模块（type-only 全部被擦除）', () => {
    expect(Object.keys(mcp)).toHaveLength(0);
    expect(Object.keys(webSse)).toHaveLength(0);
    expect(Object.keys(stt)).toHaveLength(0);
    expect(Object.keys(teams)).toHaveLength(0);
    expect(Object.keys(placeholdersIndex)).toHaveLength(0);
  });
});

// ===========================================================================
// §2 MCP：客户端形状 + 到「工具注册面」的接线证明
// ===========================================================================

/** 内存版 MCP 客户端：形状证明用（真实实现是 JSON-RPC over stdio/http） */
class FakeMcpClient implements mcp.McpClient {
  readonly serverName = 'demo-server';
  connected = false;
  disconnectCalls = 0;

  private readonly tools: readonly mcp.McpToolDescriptor[] = [
    {
      name: 'echo',
      description: '回显输入',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    },
  ];

  async connect(): Promise<void> {
    this.connected = true;
  }
  async listTools(): Promise<readonly mcp.McpToolDescriptor[]> {
    return this.tools;
  }
  async callTool(name: string, args: unknown): Promise<mcp.McpCallResult> {
    if (name !== 'echo') return { content: `unknown tool: ${name}`, isError: true };
    return { content: JSON.stringify(args), isError: false };
  }
  async disconnect(): Promise<void> {
    this.connected = false;
    this.disconnectCalls += 1; // 幂等由实现方保证——接口注释的约定
  }
}

describe('placeholders/mcp：形状可对接', () => {
  it('客户端生命周期：connect → listTools → callTool → disconnect（幂等）', async () => {
    const client = new FakeMcpClient();
    await client.connect();
    expect(client.connected).toBe(true);

    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['echo']);
    expect(await client.callTool('echo', { text: 'hi' })).toEqual({
      content: '{"text":"hi"}',
      isError: false,
    });
    expect((await client.callTool('nope', {})).isError).toBe(true);

    await client.disconnect();
    await client.disconnect(); // 幂等：第二次不炸
    expect(client.disconnectCalls).toBe(2);
  });

  it('到工具注册面的接线证明：命名空间化 + 风险由信任策略决定（非服务器声明）', async () => {
    const client = new FakeMcpClient();
    await client.connect();
    const [descriptor] = await client.listTools();

    // 解冻时的真实适配还有「JSON Schema → zod」桥（冲突 ③），
    // 这里证明的是另外两件事形状成立：
    // ① 命名空间化（防与内置工具重名，ToolRegistry 会拒绝重名）；
    // ② 风险映射来自**装配方的信任策略**，不采信服务器自报（冲突 ②）。
    const riskFor = (trust: 'trusted' | 'untrusted'): RiskLevel =>
      trust === 'trusted' ? 'low' : 'medium';

    const toToolFace = (
      serverName: string,
      d: mcp.McpToolDescriptor,
      trust: 'trusted' | 'untrusted',
    ): { name: string; description: string; risk: RiskLevel } => ({
      name: `${serverName}_${d.name}`,
      description: `[mcp:${serverName}] ${d.description}`,
      risk: riskFor(trust),
    });

    expect(toToolFace(client.serverName, descriptor!, 'untrusted')).toEqual({
      name: 'demo-server_echo',
      description: '[mcp:demo-server] 回显输入',
      risk: 'medium',
    });
  });
});

// ===========================================================================
// §3 Web/SSE：异步确认票据的完整生命周期 + ConfirmHandler 类型兼容
// ===========================================================================

/** 内存版确认经纪人：单据入表 → 悬而未决 → resolveById 兑现 */
class InMemoryBroker implements webSse.AsyncConfirmationBroker {
  private readonly tickets = new Map<
    string,
    { ticket: webSse.PendingConfirmation; resolve: (allowed: boolean) => void }
  >();

  async request(ticket: webSse.PendingConfirmation): Promise<boolean> {
    return new Promise((resolve) => {
      this.tickets.set(ticket.id, { ticket, resolve });
    });
  }
  resolveById(id: string, allowed: boolean): boolean {
    const entry = this.tickets.get(id);
    if (entry === undefined) return false;
    this.tickets.delete(id);
    entry.resolve(allowed);
    return true;
  }
  pending(): readonly webSse.PendingConfirmation[] {
    return [...this.tickets.values()].map((e) => e.ticket);
  }
}

/** 构造内核形状的确认请求（PermissionRequest） */
function permissionRequest(toolName: string): PermissionRequest {
  return { sessionId: 's1', queryId: 'q1', toolName, risk: 'high', input: { path: '/etc' } };
}

describe('placeholders/web-sse：异步确认可装配进 ConfirmHandler', () => {
  it('票据生命周期：悬挂 → 列出 → 兑现（Promise 解开 + 票据清理）', async () => {
    const broker = new InMemoryBroker();
    const ticket: webSse.PendingConfirmation = {
      id: 'c-1',
      requestedAt: 0,
      request: permissionRequest('dangerous'),
    };

    const pendingPromise = broker.request(ticket);
    expect(broker.pending()).toHaveLength(1);
    expect(broker.pending()[0]!.request.toolName).toBe('dangerous');

    expect(broker.resolveById('unknown-id', true)).toBe(false); // 未知 id：拒绝而不炸
    expect(broker.resolveById('c-1', true)).toBe(true);
    await expect(pendingPromise).resolves.toBe(true);
    expect(broker.pending()).toHaveLength(0);
  });

  it('类型兼容证明：broker.request 可直接构成 ConfirmHandler（返回 Promise<boolean>）', async () => {
    const broker = new InMemoryBroker();
    let seq = 0;

    // 这正是「PermissionGate 的 confirm 通道指向 broker」的那一行胶水代码
    const confirm: ConfirmHandler = (req) =>
      broker.request({ id: `c-${(seq += 1)}`, requestedAt: 0, request: req });

    const decisionPromise = confirm(permissionRequest('dangerous'));
    expect(broker.pending()).toHaveLength(1);

    // 模拟「前端 POST 回来点了拒绝」——confirm 的布尔语义：true = 允许
    broker.resolveById('c-1', false);
    await expect(decisionPromise).resolves.toBe(false);
  });
});

// ===========================================================================
// §4 STT：转写输出即「那一行输入」（输入层可插拔的形状证明）
// ===========================================================================

/** 内存版转写器：返回固定文本（真实实现是云 API / 本地模型） */
class FakeStt implements stt.SpeechToTextProvider {
  readonly name = 'fake-stt';
  async transcribe(audio: stt.AudioInput): Promise<stt.TranscriptionResult> {
    return { text: `（转写自 ${audio.format}）计算 1+1`, confidence: 0.98 };
  }
}

describe('placeholders/stt：转写文本与键盘输入同构', () => {
  it('transcribe 的输出就是 REPL 循环体所需要的「那行字符串」', async () => {
    const provider = new FakeStt();
    const result = await provider.transcribe({ format: 'wav', data: new Uint8Array([1, 2]) });
    expect(result.text).toBe('（转写自 wav）计算 1+1');
    expect(typeof result.text).toBe('string'); // 与 readline 的产出同型——可替换输入源
  });
});

// ===========================================================================
// §5 Teams：收件箱（消费语义）+ 共享黑板的形状证明
// ===========================================================================

/**
 * 内存版团队通道：邮件语义——**定向**投递不要求收件人在线（懒建队列，
 * 消息在箱里等订阅者）；**广播**投给已注册（订阅过）的成员（无从得知
 * 完全未知的地址——这是消息系统的本质）。该语义与 EventBus（订阅者
 * 只收订阅后的事件、且不消费）刻意不同——见 teams.ts 文件头冲突 ②。
 */
class InMemoryTeamChannel implements teams.TeamChannel {
  private readonly queues = new Map<string, teams.TeamMessage[]>();
  private seq = 0;

  post(partial: Omit<teams.TeamMessage, 'id' | 'ts'>): void {
    const message: teams.TeamMessage = { ...partial, id: `m-${(this.seq += 1)}`, ts: this.seq };
    const recipients = message.to === '*' ? [...this.queues.keys()] : [message.to];
    for (const r of recipients) {
      const queue = this.queues.get(r) ?? [];
      queue.push(message);
      this.queues.set(r, queue); // 懒建队列：消息等订阅者，而非订阅者等消息
    }
  }

  async *inbox(memberId: string): AsyncIterable<teams.TeamMessage> {
    const queue = this.queues.get(memberId) ?? [];
    this.queues.set(memberId, queue);
    let cursor = 0;
    while (true) {
      if (cursor < queue.length) {
        yield queue[cursor]!;
        cursor += 1;
      } else {
        await new Promise((r) => setTimeout(r, 1)); // 测试版轮询；真实实现用信号量
      }
    }
  }
}

/** 收集前 n 条（收满即停——收件箱是开放流，消费方决定何时离开） */
async function takeMessages(
  stream: AsyncIterable<teams.TeamMessage>,
  n: number,
): Promise<teams.TeamMessage[]> {
  const collected: teams.TeamMessage[] = [];
  for await (const message of stream) {
    collected.push(message);
    if (collected.length === n) return collected;
  }
  return collected;
}

class InMemoryBlackboard implements teams.SharedBlackboard {
  private readonly store = new Map<string, { value: string; author: string }>();
  write(key: string, value: string, author: string): void {
    this.store.set(key, { value, author });
  }
  read(key: string): string | undefined {
    return this.store.get(key)?.value;
  }
  entries(): ReadonlyMap<string, { value: string; author: string }> {
    return this.store;
  }
}

describe('placeholders/teams：收件箱与黑板的形状证明', () => {
  it('定向投递先于订阅也不丢；广播与定向各自可达（消费语义）', async () => {
    const channel = new InMemoryTeamChannel();

    // 场景 1：定向投递先于订阅——消息在箱里等订阅者（懒建队列）
    channel.post({ from: 'a', to: 'b', content: '先到的信' });

    // 场景 2：两个成员订阅（先收满即停的收集器）
    const collectingA = takeMessages(channel.inbox('a'), 1);
    const collectingB = takeMessages(channel.inbox('b'), 2); // 先到的信 + 广播
    // async generator 的函数体是**异步启动**的（next() 的 resume 在下一个
    // microtask）：等一轮让邮箱完成注册，广播才「找得到人」
    await Promise.resolve();
    channel.post({ from: 'a', to: '*', content: '广播：开始干活' });

    const [toA, toB] = await Promise.all([collectingA, collectingB]);
    expect(toA.map((m) => m.content)).toEqual(['广播：开始干活']);
    expect(toB.map((m) => m.content)).toEqual(['先到的信', '广播：开始干活']);
  });

  it('共享黑板：写读与快照（supervisor 派发决策的输入）', () => {
    const board = new InMemoryBlackboard();
    board.write('draft', '初稿……', 'writer');
    board.write('draft', '二稿……', 'writer'); // 同名覆盖
    expect(board.read('draft')).toBe('二稿……');
    expect(board.read('missing')).toBeUndefined();
    expect(board.entries().get('draft')).toEqual({ value: '二稿……', author: 'writer' });
  });
});
