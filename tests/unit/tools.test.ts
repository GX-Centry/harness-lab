/**
 * 工具层单元测试：Registry / 校验 / 内置工具 / 安全边界。
 * 锚定的决策：
 *   - 重名注册立即报错（模型可见协议面禁止静默覆盖）；
 *   - 校验失败是「给模型的 input_error 信息」（含字段路径），不是异常；
 *   - calc 不求值动态代码、除零可预期；
 *   - fs 沙箱边界：越界 permission_denied、'..foo' 合法文件不误杀、BOM 剔除。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HarnessError } from '../../src/errors.ts';
import { createBuiltinTools, echoTool } from '../../src/tools/builtin/index.ts';
import { calculatorTool } from '../../src/tools/builtin/calculator.ts';
import { fsReadTool, fsWriteTool } from '../../src/tools/builtin/fs.ts';
import { ToolRegistry } from '../../src/tools/registry.ts';
import { validateToolInput } from '../../src/tools/validation.ts';
import type { ToolContext, ToolResult } from '../../src/types.ts';
import { z } from 'zod';

function makeCtx(workingDir: string): ToolContext {
  return { sessionId: 's1', queryId: 'q1', workingDir, signal: new AbortController().signal };
}

/** 断言成功并返回 content（省去每个用例的收窄样板） */
function contentOf(result: ToolResult): string {
  expect(result.ok).toBe(true);
  return result.content;
}

/** 断言失败并返回错误码（同样用于收窄） */
function errorCodeOf(result: ToolResult): string {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('unreachable');
  return result.error.code;
}

// ===========================================================================
// Registry
// ===========================================================================

describe('ToolRegistry', () => {
  it('注册后可按名查找；list 保持注册顺序；size 正确', () => {
    const registry = new ToolRegistry();
    registry.register(echoTool).register(calculatorTool);
    expect(registry.get('echo')).toBe(echoTool);
    expect(registry.has('calculator')).toBe(true);
    expect(registry.get('nope')).toBeUndefined();
    expect(registry.list().map((t) => t.name)).toEqual(['echo', 'calculator']);
    expect(registry.size).toBe(2);
  });

  it('重名注册抛 config_error（禁止静默覆盖）', () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);
    expect(() => registry.register(echoTool)).toThrow(HarnessError);
  });

  it('toToolSpecs：zod schema 转换为模型可见的 JSON Schema', () => {
    const registry = new ToolRegistry();
    registry.register(calculatorTool);
    const specs = registry.toToolSpecs();
    expect(specs).toHaveLength(1);
    const spec = specs[0];
    expect(spec?.name).toBe('calculator');
    expect(spec?.description).toContain('四则运算');
    // JSON Schema 形状：object + properties.expression
    expect(spec?.inputSchema).toMatchObject({
      type: 'object',
      properties: { expression: expect.anything() },
      required: ['expression'],
    });
  });
});

// ===========================================================================
// 校验
// ===========================================================================

describe('validateToolInput', () => {
  it('合法参数通过并返回解析后的值与类型收窄', () => {
    const result = validateToolInput(echoTool, { message: 'hi' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input).toEqual({ message: 'hi' });
  });

  it('非法参数：失败信息包含字段路径（模型据此自我修正）', () => {
    const result = validateToolInput(echoTool, { message: 42 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('message');
      expect(result.message).toContain('参数校验失败');
    }
  });

  it('多字段同时出错：一次报全（避免多轮试错）', () => {
    const tool = {
      name: 't',
      description: 'd',
      risk: 'low' as const,
      inputSchema: z.object({ a: z.string(), b: z.number() }),
      execute: async () => ({ ok: true as const, content: '' }),
    };
    const result = validateToolInput(tool, { a: 1, b: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('a:');
      expect(result.message).toContain('b:');
    }
  });
});

// ===========================================================================
// 内置工具
// ===========================================================================

describe('echo 工具', () => {
  it('原样回显', async () => {
    const result = await echoTool.execute({ message: '你好' }, makeCtx('.'));
    expect(contentOf(result)).toBe('你好');
  });
});

describe('calculator 工具', () => {
  const calc = (expression: string): Promise<ToolResult> =>
    calculatorTool.execute({ expression }, makeCtx('.'));

  it('四则运算与优先级', async () => {
    expect(contentOf(await calc('1+2*3'))).toBe('表达式 1+2*3 = 7');
    expect(contentOf(await calc('(1+2)*3'))).toBe('表达式 (1+2)*3 = 9');
    expect(contentOf(await calc('-5+2'))).toBe('表达式 -5+2 = -3');
    expect(contentOf(await calc('10/2/5'))).toBe('表达式 10/2/5 = 1');
    expect(contentOf(await calc('3.5 * 2'))).toBe('表达式 3.5 * 2 = 7');
  });

  it('除零 → input_error（业务校验失败的范例）', async () => {
    const result = await calc('1/0');
    expect(errorCodeOf(result)).toBe('input_error');
    expect(result.content).toContain('除以零');
  });

  it('语法错误 → input_error 且提示修正方向', async () => {
    const cases: Array<[string, string]> = [
      ['1+', '意外结束'],
      ['1+abc', '非法字符'],
      ['(1+2', '缺少右括号'],
      ['1+2)', '多余'],
    ];
    for (const [expr, hint] of cases) {
      const result = await calc(expr);
      expect(errorCodeOf(result)).toBe('input_error');
      expect(result.content).toContain(hint);
      // 给模型的失败说明必须包含「怎么修」
      expect(result.content).toContain('仅支持数字');
    }
  });
});

// ===========================================================================
// fs 工具（沙箱边界）
// ===========================================================================

describe('fs 工具', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'harness-tools-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('fs_write 写入（含父目录自动创建）→ fs_read 读回', async () => {
    const writeResult = await fsWriteTool.execute(
      { path: 'out/report.md', content: '# 报告\n内容' },
      makeCtx(workDir),
    );
    expect(contentOf(writeResult)).toContain('已写入');
    const readResult = await fsReadTool.execute({ path: 'out/report.md' }, makeCtx(workDir));
    expect(contentOf(readResult)).toBe('# 报告\n内容');
  });

  it('fs_read BOM 剔除（Windows 工具链产物不留污染）', async () => {
    await writeFile(path.join(workDir, 'bom.txt'), '\uFEFF第一行\n第二行', 'utf8');
    const result = await fsReadTool.execute({ path: 'bom.txt' }, makeCtx(workDir));
    const content = contentOf(result);
    expect(content.startsWith('第一行')).toBe(true);
    expect(content.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('路径越界（../）→ permission_denied 且说明边界', async () => {
    const result = await fsReadTool.execute({ path: '../outside.txt' }, makeCtx(workDir));
    expect(errorCodeOf(result)).toBe('permission_denied');
    expect(result.content).toContain('工作目录内');
  });

  it('绝对路径越界 → permission_denied', async () => {
    const result = await fsWriteTool.execute({ path: 'C:\\Windows\\temp-evil.txt', content: 'x' }, makeCtx(workDir));
    // 注意：仅当该绝对路径不在工作目录内才是越界（教学环境成立）
    expect(errorCodeOf(result)).toBe('permission_denied');
  });

  it('"..foo" 是合法文件名：不误杀（startsWith("..") 的经典坑）', async () => {
    await writeFile(path.join(workDir, '..foo.txt'), '合法内容', 'utf8');
    const result = await fsReadTool.execute({ path: '..foo.txt' }, makeCtx(workDir));
    expect(contentOf(result)).toBe('合法内容');
  });

  it('文件不存在 → input_error（模型可自我修复的失败）', async () => {
    const result = await fsReadTool.execute({ path: 'missing.txt' }, makeCtx(workDir));
    expect(errorCodeOf(result)).toBe('input_error');
    expect(result.content).toContain('不存在');
  });

  it('读取超限截断并标记', async () => {
    await writeFile(path.join(workDir, 'long.txt'), 'A'.repeat(100), 'utf8');
    const result = await fsReadTool.execute({ path: 'long.txt', maxBytes: 10 }, makeCtx(workDir));
    const content = contentOf(result);
    expect(content.startsWith('A'.repeat(10))).toBe(true);
    expect(content).toContain('已截断');
  });

  it('createBuiltinTools 覆盖 low/medium/high 三档风险', () => {
    const risks = createBuiltinTools().map((t) => t.risk);
    expect(risks).toContain('low');
    expect(risks).toContain('medium');
    expect(risks).toContain('high');
  });
});
