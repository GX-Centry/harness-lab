/**
 * ToolRegistry —— 工具的注册与查找中心。
 *
 * 设计要点：
 *   1. **纯数据结构，不做执行**：执行只发生在 Dispatcher（四步执行链的唯一入口）。
 *      这样「参数校验 / 权限 / hook」全都在执行前发生，乱序风险从结构上被排除。
 *   2. **zod → JSON Schema 的转换在这里**（toToolSpecs）：
 *      同一个 inputSchema 一物两用——进程内校验用 zod 原样，给模型的声明用
 *      JSON Schema（z.toJSONSchema() 由 zod v4 内置，零额外依赖）。
 *   3. **重复注册直接报 config_error**：工具名是模型可见的协议面，
 *      静默覆盖会导致「模型调用的和实际执行的不是同一个」这类极其隐蔽的 bug。
 *
 * 依赖方向：tools/registry.ts → types.ts / errors.ts。
 */

import { z } from 'zod';
import { HarnessError } from '../errors.ts';
import type { AnyTool, ToolSpec } from '../types.ts';

export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();

  /**
   * 注册工具（幂等失败：重名立即抛 config_error）。
   * 泛型入口签名在「注册时」享受类型检查（Tool<T> 的 schema 与 execute 的一致性），
   * 容器内部退化为 AnyTool——异构容器的经典取舍（见 types.ts AnyTool 注释）。
   */
  register(tool: AnyTool): this {
    if (this.tools.has(tool.name)) {
      throw new HarnessError('config_error', `工具名重复注册: "${tool.name}"（工具名是模型可见协议，禁止静默覆盖）`, {
        where: 'tools/registry',
      });
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  /** 查找工具；未找到返回 undefined——「未知工具」的处理权交给 Dispatcher（生成工具结果，而非抛错） */
  get(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** 全部工具（按注册顺序——稳定排序，保证发给模型的声明列表可复现） */
  list(): readonly AnyTool[] {
    return [...this.tools.values()];
  }

  get size(): number {
    return this.tools.size;
  }

  /**
   * 转成给模型的工具声明列表。
   *
   * 教学注释（两个真实坑点）：
   *   - z.toJSONSchema 对含 transform / refine 等「不可表示」的 schema 会抛错，
   *     所以工具 schema 要保持「纯数据形状」（校验逻辑放 execute 里做）；
   *   - 每轮对话都要用声明列表，生产实现应在 register 时预转换并缓存
   *     （这里每次现转——工具少且无性能压力，教学优先语义直白）。
   */
  toToolSpecs(): ToolSpec[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.inputSchema) as ToolSpec['inputSchema'],
    }));
  }
}
