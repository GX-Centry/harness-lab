/**
 * real-provider 单元测试：环境变量 → RealProviderConfig 的解析规则。
 *
 * 锚定的决策（对应实现文件头的判定规则）：
 *   - API_KEY 或 BASE_URL 任一存在 → 启用真实模式；三者皆缺 → undefined
 *     （装配层据此回落离线演示规则 Provider）；
 *   - 缺省值补全：baseUrl → DeepSeek、model → deepseek-chat（「解析结果
 *     三个值都已补全」，不是原样透传的空值集合）；
 *   - 前后空白被 trim；仅含空白视同未设置。
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from '../../src/llm/openai-compatible-provider.ts';
import { resolveRealProviderConfig } from '../../src/llm/real-provider.ts';

describe('resolveRealProviderConfig', () => {
  it('三者皆缺 → undefined（装配层回落演示模式）', () => {
    expect(resolveRealProviderConfig({})).toBeUndefined();
  });

  it('只有 MODEL → undefined（模型名本身不足以启用真实模式）', () => {
    expect(resolveRealProviderConfig({ HARNESS_LLM_MODEL: 'deepseek-chat' })).toBeUndefined();
  });

  it('仅空白串 → undefined（视同未设置）', () => {
    expect(resolveRealProviderConfig({ HARNESS_LLM_API_KEY: '  ' })).toBeUndefined();
    expect(resolveRealProviderConfig({ HARNESS_LLM_BASE_URL: '\t' })).toBeUndefined();
  });

  it('只有 key → baseUrl / model 补缺省', () => {
    expect(resolveRealProviderConfig({ HARNESS_LLM_API_KEY: 'sk-1' })).toEqual({
      apiKey: 'sk-1',
      baseUrl: DEFAULT_BASE_URL,
      model: DEFAULT_MODEL,
    });
  });

  it('只有 baseUrl（本地无鉴权服务场景）→ apiKey 为空串', () => {
    expect(resolveRealProviderConfig({ HARNESS_LLM_BASE_URL: 'http://127.0.0.1:11434/v1' })).toEqual({
      apiKey: '',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: DEFAULT_MODEL,
    });
  });

  it('三值齐全 → 原样透传（各自 trim）', () => {
    expect(
      resolveRealProviderConfig({
        HARNESS_LLM_API_KEY: ' sk-2 ',
        HARNESS_LLM_BASE_URL: ' https://api.x.com/v1 ',
        HARNESS_LLM_MODEL: ' qwen3:8b ',
      }),
    ).toEqual({ apiKey: 'sk-2', baseUrl: 'https://api.x.com/v1', model: 'qwen3:8b' });
  });
});
