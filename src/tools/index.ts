/**
 * 工具层模块出口。
 * 公开内容：Registry（注册/查找/声明转换）、输入校验、内置工具集。
 * Tool 协议本身（Tool / ToolResult / ToolContext）定义在 src/types.ts——
 * 它是全系统共享的「词汇表」，不属于本模块私有。
 */

export * from './registry.ts';
export * from './validation.ts';
export * from './builtin/index.ts';
