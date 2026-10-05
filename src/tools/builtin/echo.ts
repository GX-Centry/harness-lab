/**
 * echo 工具 —— 最小可用的工具范例（教学「基准线」）。
 *
 * 用途：
 *   - 场景测试里验证「工具调用链路」（模型发起 → Dispatcher 四步链 → 结果回填）时，
 *     用它的输出可预测性做断言；
 *   - 用最短代码展示 Tool 协议的全部五个成员该怎么写。
 *
 * risk = low：纯计算、无副作用、无外部依赖 → 默认策略 allow 放行。
 */

import { z } from 'zod';
import type { Tool } from '../../types.ts';
import { okResult } from '../../types.ts';

/** 输入类型显式声明：即 schema 的静态形状，也是 execute 参数类型（两者由 TS 交叉验证） */
interface EchoInput {
  readonly message: string;
}

export const echoTool: Tool<EchoInput> = {
  name: 'echo',
  description: '原样回显输入文本。用于验证工具调用链路是否通畅。',

  // schema 即文档：describe() 的内容会随 z.toJSONSchema() 进入模型可见的工具声明
  inputSchema: z.object({
    message: z.string().describe('要回显的文本'),
  }),

  risk: 'low',

  async execute(input) {
    // execute 可以确信 input 已通过 schema 校验（协议承诺，见 types.ts Tool 注释）
    return okResult(input.message);
  },
};
