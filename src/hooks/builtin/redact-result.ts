/**
 * redact-result hook —— 工具结果中的敏感信息脱敏。
 *
 * 为什么脱敏放在**结果侧**而不是参数侧？
 *   参数脱敏会让工具拿到假数据（密码字段被替换成 [REDACTED]，工具就没法登录）。
 *   敏感信息的正确治理点：
 *     1. 参数进日志/审计时的脱敏 → 由 audit hook 的记录策略负责；
 *     2. 工具**输出**里的敏感值（API key 回显、凭证泄漏）→ 本 hook 负责——
 *        因为结果下一步就会进入模型上下文与会话持久化。
 *
 * 模式匹配是启发式的（教学版给出三种典型模式）；生产实践会结合
 * 熵检测与结构化字段路径（如 meta.secret 字段直接打码）。
 * 命中任一模式 → modify_result；未命中 → continue（零改动通过）。
 */

import type { Hook } from '../../types.ts';
import { replaceResultContent } from './shared.ts';

interface RedactPattern {
  readonly name: string;
  readonly regex: RegExp;
  readonly replacement: string;
}

const DEFAULT_PATTERNS: readonly RedactPattern[] = [
  {
    name: 'api_key',
    // OpenAI 风格 sk- 开头的密钥
    regex: /\bsk-[A-Za-z0-9_-]{8,}\b/g,
    replacement: '[REDACTED_API_KEY]',
  },
  {
    name: 'bearer_token',
    // Authorization: Bearer <token>
    regex: /(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi,
    replacement: '$1[REDACTED_TOKEN]',
  },
  {
    name: 'password_field',
    // password=xxx / "password": "xxx" 样式
    regex: /(password["']?\s*[:=]\s*["']?)([^\s"',;]{3,})/gi,
    replacement: '$1[REDACTED_PASSWORD]',
  },
];

export interface RedactResultOptions {
  readonly patterns?: readonly RedactPattern[];
}

export function createRedactResultHook(options: RedactResultOptions = {}): Hook {
  const patterns = options.patterns ?? DEFAULT_PATTERNS;
  return {
    name: 'redact-result',
    priority: 20,
    events: ['tool_call_after'],
    async handler(payload) {
      const result = payload.result;
      if (result === undefined) return { kind: 'continue' };
      let content = result.content;
      for (const pattern of patterns) {
        content = content.replace(pattern.regex, pattern.replacement);
      }
      if (content === result.content) return { kind: 'continue' };
      return { kind: 'modify_result', result: replaceResultContent(result, content) };
    },
  };
}
