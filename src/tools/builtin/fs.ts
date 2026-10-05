/**
 * 文件系统工具（fs_read / fs_write）—— 演示「工具安全边界」的真实样本。
 *
 * 这两个工具承载了全部高危安全语义，是学习「工具层如何防御」的最佳样本：
 *
 * 1. **沙箱边界（workingDir）**：
 *    一切相对路径解析到 ctx.workingDir，且解析结果必须仍在其内部——
 *    这是防御「路径遍历攻击」（../../etc/passwd）的第一道墙。
 *    注意 `rel.startsWith('..')` 的经典误判：名为 "..foo" 的合法文件
 *    会被误杀；正确写法是判断 `rel === '..'` 或 `rel.startsWith('..' + 分隔符)`。
 *
 * 2. **风险分级与权限联动**：
 *    fs_read = medium（读取本地资源）、fs_write = high（写操作）。
 *    在默认策略下分别触发 confirm / confirm——权限层（w07）依赖这个声明。
 *
 * 3. **错误码映射**（fs 错误 → 工具错误码，模型据此决定能不能自我修复）：
 *    ENOENT → input_error（路径错，模型可改）；EACCES/EPERM → permission_denied；
 *    EISDIR → input_error；其余 → service_error。
 *
 * 4. **UTF-8 BOM 处理**（环境坑点，见 docs/00-environment.md）：
 *    Windows 工具链产出的文件常带 BOM（U+FEFF），读取后必须剔除——
 *    否则它会混进模型上下文，也会让首行字符串比较全部失败。
 *
 * 教学简化的已知边界（注释保留，演进点）：
 *   - 未做 fs.realpath 对比：符号链接 / Windows 大小写差异的绕过在此版本中
 *     不被防御（真实生产必须补上 realpath 后再做边界判断）；
 *   - 截断按字节切分，可能切到 UTF-8 多字节字符中间——已做「尾部补位清理」，
 *     精确处理应按字符边界回退。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Tool, ToolResult } from '../../types.ts';
import { failedResult, okResult } from '../../types.ts';

// ---------------------------------------------------------------------------
// 共享防御函数
// ---------------------------------------------------------------------------

const DEFAULT_MAX_BYTES = 64 * 1024;

/**
 * 把相对路径解析进工作目录；越界返回 undefined。
 *
 * 防御逻辑（两层）：
 *   1. path.resolve 归一化（消除 "a/../b"、"a//b" 等花式写法再比较）；
 *   2. path.relative 判断结果是否仍位于 base 内——用「相对路径是否以 ..
 *      开头」表达，且必须处理「..foo 是合法文件名」的边界。
 */
function resolveInside(workingDir: string, relative: string): string | undefined {
  const base = path.resolve(workingDir);
  const abs = path.resolve(base, relative);
  const rel = path.relative(base, abs);
  // rel === '' 表示目标就是 base 自身（允许——具体工具再决定语义）
  if (rel === '') return abs;
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return undefined; // 越界
  }
  return abs;
}

/** 剔除 UTF-8 BOM（Windows 工具链的常见产物，混入上下文会污染首行比较） */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** fs 错误 → 工具错误码映射（模型据此判断「能不能自我修复」） */
function mapFsError(raw: unknown, target: string): ToolResult {
  const code = raw instanceof Error ? (raw as NodeJS.ErrnoException).code : undefined;
  if (code === 'ENOENT') {
    return failedResult('input_error', `文件不存在: ${target}`, `路径 "${target}" 不存在。请检查拼写或先创建文件。`);
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return failedResult('permission_denied', `系统权限拒绝: ${target}`);
  }
  if (code === 'EISDIR') {
    return failedResult('input_error', `目标是目录而非文件: ${target}`, `"${target}" 是目录。请指定具体文件路径。`);
  }
  const message = raw instanceof Error ? raw.message : String(raw);
  return failedResult('service_error', `文件操作失败 (${target}): ${message}`);
}

// ---------------------------------------------------------------------------
// fs_read
// ---------------------------------------------------------------------------

interface FsReadInput {
  readonly path: string;
  readonly maxBytes?: number;
}

export const fsReadTool: Tool<FsReadInput> = {
  name: 'fs_read',
  description:
    '读取工作目录内的文本文件。路径必须位于工作目录内；默认最多读取 64KB，超出部分截断并标记。',
  inputSchema: z.object({
    path: z.string().min(1).describe('相对工作目录的文件路径，例如 "notes/todo.txt"'),
    maxBytes: z.number().int().positive().max(1024 * 1024).optional().describe('最大读取字节数，默认 65536'),
  }),
  risk: 'medium', // 读取本地资源：默认策略 confirm

  async execute(input, ctx): Promise<ToolResult> {
    const abs = resolveInside(ctx.workingDir, input.path);
    if (abs === undefined) {
      // 越界不是异常，而是「给模型看的拒绝」：告诉它边界在哪，它就知道怎么改
      return failedResult(
        'permission_denied',
        `路径越界: ${input.path}`,
        `拒绝访问 "${input.path}"：只能读取工作目录内的文件。请使用工作目录内的相对路径。`,
      );
    }
    try {
      const buffer = await readFile(abs);
      const limit = input.maxBytes ?? DEFAULT_MAX_BYTES;
      const sliced = buffer.subarray(0, limit);
      let text = stripBom(sliced.toString('utf8'));
      // 字节截断可能落在多字节字符中间（产生 U+FFFD 替换符）——清掉尾部残片
      if (text.endsWith('\uFFFD')) {
        text = text.slice(0, -1);
      }
      const truncated = buffer.byteLength > limit;
      const suffix = truncated
        ? `\n...[已截断：文件共 ${buffer.byteLength} 字节，仅显示前 ${limit} 字节]`
        : '';
      return okResult(`${text}${suffix}`, {
        path: abs,
        bytes: buffer.byteLength,
        truncated,
      });
    } catch (raw) {
      return mapFsError(raw, input.path);
    }
  },
};

// ---------------------------------------------------------------------------
// fs_write
// ---------------------------------------------------------------------------

interface FsWriteInput {
  readonly path: string;
  readonly content: string;
}

export const fsWriteTool: Tool<FsWriteInput> = {
  name: 'fs_write',
  description: '把文本内容写入工作目录内的文件（自动创建父目录；已存在则覆盖）。',
  inputSchema: z.object({
    path: z.string().min(1).describe('相对工作目录的文件路径，例如 "out/report.md"'),
    content: z.string().describe('要写入的完整文本内容'),
  }),
  risk: 'high', // 写操作：默认策略 confirm（对话内人工确认）

  async execute(input, ctx): Promise<ToolResult> {
    const abs = resolveInside(ctx.workingDir, input.path);
    if (abs === undefined) {
      return failedResult(
        'permission_denied',
        `路径越界: ${input.path}`,
        `拒绝写入 "${input.path}"：只能写入工作目录内的文件。`,
      );
    }
    try {
      const parent = path.dirname(abs);
      await mkdir(parent, { recursive: true }); // 幂等创建父目录：exists 检查是竞态的，recursive 才是正确姿势
      await writeFile(abs, input.content, 'utf8');
      return okResult(`已写入 ${input.content.length} 个字符到 "${input.path}"`, {
        path: abs,
        chars: input.content.length,
      });
    } catch (raw) {
      return mapFsError(raw, input.path);
    }
  },
};
