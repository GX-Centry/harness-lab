/**
 * CLI 演示剧本 —— 规则驱动的确定性「模型」（FakeProvider.rules 的消费方，w17）。
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 定位：CLI 对话模式的默认 Provider 从哪来                               │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * 四项决策之③「FakeProvider 打底 + 真实 Provider 预留」在 CLI 形态下的
 * 落地：对话模式的模型调用由**规则表**应答——同一输入永远同一回复，
 * 离线、零成本、可复现。这不是「权宜之计」，而是演示模式的正确形态：
 *   - REPL 的管道（会话/记忆/命令/子代理/权限）是 CLI 要展示的主体；
 *   - 模型的智能程度在这一层毫无意义——确定性反而让 demo 可断言。
 *
 * 规则顺序 = 优先级（首个命中者胜出），兜底规则（match: ''）必须垫底。
 * 规则的动态形态（函数）读取请求上下文——这是「多轮对话」在规则模式下的
 * 表达方式：识别「最后一条消息是 tool 结果」→ 出总结回合（不再调工具）。
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 真实 Provider 怎么接（预留指引）                                      │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * 实现 LLMProvider 接口（stream + complete + countTokens）后，在 app.ts 的
 * Provider 工厂处替换本模块即可——装配层是唯一的替换点（见 app.ts 注释）。
 * 真实接入要处理的三件事（接口已为它留好形状）：
 *   1. StreamEvent 的翻译（各家的 SSE 协议 → 规范形分片）；
 *   2. countTokens 的精度（官方 tokenizer；当前规则模式用近似公式）；
 *   3. req.signal 传入 HTTP 客户端（协作式取消）。
 *
 * 依赖方向：cli/demo.ts → llm/fake-provider + types（零内核依赖——
 * 演示剧本甚至可以拿去喂给别的宿主）。
 */

import type { FakeRule } from '../llm/fake-provider.ts';
import { FakeProvider } from '../llm/fake-provider.ts';
import type { LLMRequest, Message } from '../types.ts';

// ===========================================================================
// §1 小工具（规则函数里用的请求状态读取）
// ===========================================================================

/** 请求消息的尾条（规则函数用它判断对话阶段） */
function tailOf(req: LLMRequest): Message | undefined {
  return req.messages[req.messages.length - 1];
}

/** 最后一条 user 消息（子代理场景里它是任务描述） */
function lastUserOf(req: LLMRequest): string | undefined {
  for (let i = req.messages.length - 1; i >= 0; i -= 1) {
    const message = req.messages[i];
    if (message !== undefined && message.role === 'user') return message.content;
  }
  return undefined;
}

/** 从用户输入里提取「最像算式」的片段（教学级启发式：错提了有工具校验兜底） */
function extractExpression(content: string): string | undefined {
  const segments = content.match(/[-+*/().\d\s]+/g) ?? [];
  const candidates = segments
    .map((s) => s.trim())
    .filter((s) => /\d/.test(s) && /[+\-*/]/.test(s)); // 必须有数字与运算符
  candidates.sort((a, b) => b.length - a.length); // 取最长片段（最像完整算式）
  return candidates[0];
}

// ===========================================================================
// §2 主对话的规则表
// ===========================================================================

/** 计算：识别算式 → 调用 calculator；工具结果回来后 → 总结回合 */
const computeRule: FakeRule = {
  match: /计算|算一算|算一下|calculate|[\d.]+\s*[+\-*/]\s*[\d.]/i,
  turn: (req) => {
    const tail = tailOf(req);
    if (tail?.role === 'tool') {
      // 对话第二阶段：工具结果已回注（tail 是 tool 消息）——出总结，不再调工具
      return { text: `结果是 ${tail.content}。` };
    }
    const expression = extractExpression(lastUserOf(req) ?? '');
    if (expression === undefined) {
      return { text: '想让我算什么？给我一个算式，比如「计算 123 * 45」。' };
    }
    return {
      text: '好，用计算器算一下。',
      toolCalls: [{ name: 'calculator', args: { expression } }],
    };
  },
};

/** 调研：派 researcher 子代理（演示 fan-out 的最小形态：Agent-as-Tool） */
const researchRule: FakeRule = {
  match: /调研|研究|子代理|researcher/i,
  turn: (req) => {
    const tail = tailOf(req);
    if (tail?.role === 'tool') {
      // 子代理的摘要已作为工具结果回注——父世界只看到摘要（隔离层 4）
      return { text: `调研完成，结论如下：\n${tail.content}` };
    }
    return {
      text: '收到，派研究员子代理去处理。',
      toolCalls: [{ name: 'researcher', args: { task: lastUserOf(req) ?? '通用调研任务' } }],
    };
  },
};

/** 问候 */
const greetingRule: FakeRule = {
  match: /^\s*(你好|您好|hi|hello|嗨)/i,
  turn: {
    text:
      '你好。这是 harness-lab 的确定性演示模式（模型由规则脚本驱动，离线可复现）。\n' +
      '可以试试：\n' +
      '  · 「计算 123 * 45」—— 工具调用闭环\n' +
      '  · 「帮我调研一个问题」—— 子代理 fan-out\n' +
      '  · /help —— 查看斜杠命令（命令不进模型）',
  },
};

/** 帮助（对话式的，/help 是命令式的——两者对照展示「两条路」） */
const helpRule: FakeRule = {
  match: /帮助|help|能做什么|怎么用/i,
  turn: {
    text:
      '我能演示：计算（「计算 123*45」）、调研（「帮我调研……」）、\n' +
      '以及完整的会话管道——消息持久化、跨会话记忆、斜杠命令、权限确认。\n' +
      '斜杠命令请用 /help 查看（命令在进模型之前就被拦截）。',
  },
};

/**
 * 兜底（match: '' 恒命中，必须垫底）：
 * 工具结果刚回来 → 出总结；否则 → 复述 + 引导。
 * 这个「复述」不是智能，是**确定性**——演示模式对未知输入的应答策略。
 */
const fallbackRule: FakeRule = {
  match: '',
  turn: (req) => {
    const tail = tailOf(req);
    if (tail?.role === 'tool') {
      return { text: `工具返回：${tail.content}` };
    }
    return {
      text:
        `（演示模式·确定性应答）我收到了：「${(lastUserOf(req) ?? '').trim()}」\n` +
        '试试「计算 12*8」「帮我调研 X」「你好」，或用 /help 看命令。',
    };
  },
};

/** 主对话规则表（顺序即优先级，兜底垫底） */
export function createDemoRules(): readonly FakeRule[] {
  return [computeRule, researchRule, greetingRule, helpRule, fallbackRule];
}

// ===========================================================================
// §3 Provider 工厂（app.ts 的唯一 Provider 装配点）
// ===========================================================================

export interface DemoProviderOptions {
  /** 分片间延迟（毫秒，默认 18）：让流式渐进肉眼可见——演示体验的一部分 */
  readonly chunkDelayMs?: number;
}

/** 主对话 Provider：规则驱动（script 为空——规则恒有兜底，永不耗尽） */
export function createDemoProvider(options: DemoProviderOptions = {}): FakeProvider {
  return new FakeProvider({
    script: [],
    rules: createDemoRules(),
    chunkDelayMs: options.chunkDelayMs ?? 18,
  });
}

/**
 * 子代理 Provider：子世界专用规则（只有一条兜底）。
 * 为什么不复用主规则表：子世界的工具子集只有 calculator/echo——若子规则
 * 又派 researcher，会触发「未知工具」拒绝并引发子循环自旋。子代理的
 * 演示语义是「接到任务 → 直接给结论摘要」——一条兜底规则恰好表达它。
 */
export function createSubagentDemoProvider(): FakeProvider {
  return new FakeProvider({
    script: [],
    rules: [
      {
        match: '',
        turn: (req) => {
          const task = (lastUserOf(req) ?? '（无任务描述）').trim();
          return {
            text: `（研究员·子代理）已处理任务：「${task}」。\n结论（演示数据）：该问题可以从两个角度回答——先列要点，再给建议。`,
          };
        },
      },
    ],
    chunkDelayMs: 10,
  });
}
