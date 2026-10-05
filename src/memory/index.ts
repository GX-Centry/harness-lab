/**
 * memory 模块出口（模块边界即目录的兑现——外部只 import 本文件）。
 *
 * 模块分层（详见各文件头）：
 *   store.ts     跨会话记忆的持久化（memories 表，与 session 共享 db 文件）
 *   retriever.ts 分词 / 打分 / 过滤 / 组装注入（纯函数）
 *   trigger.ts   写入白名单（纯函数，「该不该记」的确定性判断）
 *   manager.ts   门面：检索与触发的 query 生命周期挂点 + 事件上报 + 降级
 */

export * from './manager.ts';
export * from './retriever.ts';
export * from './store.ts';
export * from './trigger.ts';
