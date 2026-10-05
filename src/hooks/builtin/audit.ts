/**
 * audit hook —— 每次工具调用后生成一行审计记录。
 *
 * 设计要点：
 *   - 挂在 post 阶段（tool_call_after）：此刻「谁、用什么参数、结果如何、耗时多少」
 *     全部已知，是审计信息最完整的时刻；
 *   - 记录不写文件、不碰数据库——通过 ctx.log 输出。日志的最终去处由装配层
 *     决定（CLI 打印 / 事件流 / 落盘），hook 保持「只生成事实」的单一职责；
 *   - 参数摘要经过 brief 截断：审计日志不应该把整个文件内容抄进去。
 *
 * priority = 10：审计要看到「加工前」的结果吗？不——审计看最终结果即可，
 * 但它应该在其他结果加工 hook 之前跑，这样记录的仍是工具的原始输出。
 */

import type { Hook } from '../../types.ts';
import { brief, stableStringify } from './shared.ts';

export function createAuditHook(): Hook {
  return {
    name: 'audit',
    priority: 10,
    events: ['tool_call_after'],
    async handler(payload, ctx) {
      const toolName = payload.tool?.name ?? payload.toolCall?.name ?? '?';
      const result = payload.result;
      const status = result === undefined ? 'no_result' : result.ok ? 'ok' : `fail(${result.error.code})`;
      const inputBrief = brief(stableStringify(payload.input ?? {}), 100);
      ctx.log(`[audit] tool=${toolName} status=${status} input=${inputBrief}`);
      return { kind: 'continue' };
    },
  };
}
