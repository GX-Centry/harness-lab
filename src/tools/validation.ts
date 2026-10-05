/**
 * 工具输入校验 —— zod schema 作为执行入口的守门员。
 *
 * 时机与职责：
 *   Dispatcher 拿到 ToolCall.args（模型给的 unknown）后、执行工具前，
 *   必须经过这里校验。校验失败**不是异常**——它转成 input_error 的工具结果
 *   返回给模型（ADR-004），模型看到具体哪个字段错了会自我修正重试。
 *
 * 错误信息设计（给模型看的）：
 *   - 包含字段路径（如 "expression" / "path"）；
 *   - 包含期望与实际（zod 的 issue message 已含）；
 *   - 汇总所有 issue（首错即停会迫使模型多轮试错，一条消息报全更高效）。
 *
 * 依赖方向：tools/validation.ts → zod / types.ts。
 */

import type { AnyTool } from '../types.ts';

export type InputValidation =
  | { readonly ok: true; readonly input: unknown }
  | { readonly ok: false; readonly message: string };

/**
 * 用工具的 zod schema 校验原始参数。
 * 返回判别联合而不是抛错：调用方（Dispatcher）把它翻译成工具结果。
 */
export function validateToolInput(tool: AnyTool, rawArgs: unknown): InputValidation {
  const parsed = tool.inputSchema.safeParse(rawArgs);
  if (parsed.success) {
    return { ok: true, input: parsed.data };
  }
  // 汇总全部 issue：`字段路径: 问题描述`
  const details = parsed.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(根)';
    return `${path}: ${issue.message}`;
  });
  return { ok: false, message: `参数校验失败 → ${details.join('; ')}` };
}
