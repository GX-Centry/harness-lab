/**
 * 内置工具集合 —— 演示场景的最小工具箱。
 *
 * 组成与设计意图：
 *   echo         最小基准线（验证调用链路）
 *   calculator   纯计算 + 安全求值示范（low）
 *   fs_read      读取本地资源 + 沙箱边界（medium）
 *   fs_write     写操作 + 高风险确认路径（high）
 *
 * 风险级覆盖 low/medium/high 三档——Permission 层（w07）的规则与确认交互
 * 需要这三种样本才能在测试里走通全部决策分支。
 */

import type { AnyTool } from '../../types.ts';
import { calculatorTool } from './calculator.ts';
import { echoTool } from './echo.ts';
import { fsReadTool, fsWriteTool } from './fs.ts';

export { calculatorTool, echoTool, fsReadTool, fsWriteTool };

/** 返回全部内置工具的工厂（每次调用返回新数组，工具对象本身可共享—无状态） */
export function createBuiltinTools(): AnyTool[] {
  return [echoTool, calculatorTool, fsReadTool, fsWriteTool];
}
