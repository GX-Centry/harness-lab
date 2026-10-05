/**
 * calculator 工具 —— 演示「工具协议 + 安全边界」的核心范例。
 *
 * 为什么不做动态求值（把表达式直接交给 JavaScript 引擎编译执行）？
 *   工具参数来自模型，而模型可能被提示注入操控。动态求值等于把
 *   「任意代码执行权」交给一段不可信文本——这是工具层的第一安全课。
 *   本实现用约 60 行递归下降解析器求值：
 *
 *     表达式 := 项 (('+' | '-') 项)*
 *     项     := 因子 (('*' | '/') 因子)*
 *     因子   := 数字 | '(' 表达式 ')' | '-' 因子
 *
 *   只做四则运算与括号、一元负号——够演示，且攻击面为零。
 *
 * 错误语义（全部是模型可修正的 input_error）：
 *   - 非法字符 / 语法错误 / 括号不配对 → input_error（提示正确语法）
 *   - 除以零 → input_error（天然的"业务校验失败"示例）
 */

import { z } from 'zod';
import type { Tool, ToolResult } from '../../types.ts';
import { failedResult, okResult } from '../../types.ts';

interface CalculatorInput {
  readonly expression: string;
}

// ---------------------------------------------------------------------------
// 词法分析（tokenizer）
// ---------------------------------------------------------------------------

type Token =
  | { readonly kind: 'num'; readonly value: number }
  | { readonly kind: 'op'; readonly op: '+' | '-' | '*' | '/' }
  | { readonly kind: 'lparen' }
  | { readonly kind: 'rparen' };

/**
 * 表达式内部错误：只在本文件内抛出，在 execute 边界统一转成 ToolResult。
 * 教学点：工具内部允许 throw 控制复杂解析流程，但**边界必须转换**（ADR-004）。
 */
class ExpressionError extends Error {}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source.charAt(i);
    if (ch === ' ' || ch === '\t') {
      i += 1;
      continue;
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/') {
      tokens.push({ kind: 'op', op: ch });
      i += 1;
      continue;
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen' });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen' });
      i += 1;
      continue;
    }
    if (isDigit(ch) || ch === '.') {
      // 数字：连续的数字与小数点（不校验多个小数点——Number() 会拒绝并进入外层错误路径）
      let j = i;
      while (j < source.length) {
        const c = source.charAt(j);
        if (!isDigit(c) && c !== '.') break;
        j += 1;
      }
      const text = source.slice(i, j);
      const value = Number(text);
      if (Number.isNaN(value)) {
        throw new ExpressionError(`无法解析数字 "${text}"`);
      }
      tokens.push({ kind: 'num', value });
      i = j;
      continue;
    }
    throw new ExpressionError(`非法字符 "${ch}"`);
  }
  return tokens;
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

// ---------------------------------------------------------------------------
// 递归下降求值
// ---------------------------------------------------------------------------

/** 解析游标：tokens 只读，pos 随递归推进（可变状态收在一个对象里，函数间显式传递） */
interface ParseState {
  readonly tokens: readonly Token[];
  pos: number;
}

function parseExpression(state: ParseState): number {
  let value = parseTerm(state);
  for (;;) {
    const token = state.tokens[state.pos];
    if (token?.kind === 'op' && (token.op === '+' || token.op === '-')) {
      state.pos += 1;
      const rhs = parseTerm(state);
      value = token.op === '+' ? value + rhs : value - rhs;
    } else {
      return value;
    }
  }
}

function parseTerm(state: ParseState): number {
  let value = parseFactor(state);
  for (;;) {
    const token = state.tokens[state.pos];
    if (token?.kind === 'op' && (token.op === '*' || token.op === '/')) {
      state.pos += 1;
      const rhs = parseFactor(state);
      if (token.op === '/' && rhs === 0) {
        throw new ExpressionError('除以零');
      }
      value = token.op === '*' ? value * rhs : value / rhs;
    } else {
      return value;
    }
  }
}

function parseFactor(state: ParseState): number {
  const token = state.tokens[state.pos];
  if (token === undefined) {
    throw new ExpressionError('表达式意外结束');
  }
  if (token.kind === 'num') {
    state.pos += 1;
    return token.value;
  }
  if (token.kind === 'op' && token.op === '-') {
    state.pos += 1;
    return -parseFactor(state); // 一元负号：-x 等价于 0-x
  }
  if (token.kind === 'lparen') {
    state.pos += 1;
    const value = parseExpression(state);
    const close = state.tokens[state.pos];
    if (close?.kind !== 'rparen') {
      throw new ExpressionError('缺少右括号');
    }
    state.pos += 1;
    return value;
  }
  throw new ExpressionError('意外的符号');
}

/** 求值入口：词法 → 语法 → 校验无剩余 token */
function evaluate(source: string): number {
  const tokens = tokenize(source);
  if (tokens.length === 0) {
    throw new ExpressionError('表达式为空');
  }
  const state: ParseState = { tokens, pos: 0 };
  const value = parseExpression(state);
  if (state.pos < tokens.length) {
    throw new ExpressionError('表达式末尾有多余内容');
  }
  return value;
}

// ---------------------------------------------------------------------------
// Tool 协议实现
// ---------------------------------------------------------------------------

export const calculatorTool: Tool<CalculatorInput> = {
  name: 'calculator',
  description: '计算四则运算表达式（支持 + - * /、括号与小数；例如 "(1+2)*3.5"）。',

  inputSchema: z.object({
    expression: z.string().min(1).describe('数学表达式，例如 "12 * (3 + 4)"'),
  }),

  risk: 'low', // 纯计算、无副作用

  async execute(input): Promise<ToolResult> {
    try {
      const value = evaluate(input.expression);
      return okResult(`表达式 ${input.expression} = ${value}`);
    } catch (raw) {
      if (raw instanceof ExpressionError) {
        // 给模型的失败说明包含「怎么修」：语法提示比单纯报错更省对话轮次
        return failedResult(
          'input_error',
          `计算失败: ${raw.message}`,
          `无法计算 "${input.expression}"：${raw.message}。仅支持数字、+ - * /、括号与一元负号，例如 "12 * (3 + 4)"。`,
        );
      }
      // 兜底：协议承诺「永不抛」由工具自己兑现——未知异常也变成工具结果
      const message = raw instanceof Error ? raw.message : String(raw);
      return failedResult('internal_error', `计算器内部错误: ${message}`);
    }
  },
};
