/**
 * 真实 Provider 的「环境变量解析层」—— 配置与进程环境之间的唯一入口。
 *
 * 三个环境变量（组合使用；也支持同名 .env 文件，见 loadDotEnv）：
 *   HARNESS_LLM_API_KEY    API 密钥（本地服务可留空——不发 Authorization 头）
 *   HARNESS_LLM_BASE_URL   OpenAI 兼容端点（缺省 https://api.deepseek.com/v1）
 *   HARNESS_LLM_MODEL      模型名（缺省 deepseek-chat）
 *
 * 判定规则：API_KEY 或 BASE_URL 任一存在 → 启用真实 Provider；
 * 两者都缺 → undefined（装配层回落演示规则 Provider——离线确定性地基不变）。
 *
 * 与网页设置面板的关系（两个入口，一个构造点）：
 *   - CLI（main.ts）：启动时读环境 → 静态装配；
 *   - 网页（web.ts）：启动时读环境作为缺省，运行时可在设置面板热切换
 *     （两个入口最终都构造同一个 OpenAICompatibleProvider）。
 */

import { DEFAULT_BASE_URL, DEFAULT_MODEL } from './openai-compatible-provider.ts';

/** 解析结果：三个值都已补全缺省（不是「原样透传的空值集合」） */
export interface RealProviderConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
}

/**
 * 加载项目根目录的 .env（可选；文件不存在则静默跳过）。
 * 用 Node 内建 process.loadEnvFile（20.12+）——零依赖，无需 dotenv。
 * 时序约定：必须在任何读取 process.env 的逻辑之前调用（入口文件顶部）。
 */
export function loadDotEnv(): void {
  try {
    process.loadEnvFile();
  } catch {
    // .env 不存在（或不可读）：演示模式不依赖它——静默继续
  }
}

/**
 * 从环境变量解析真实 Provider 配置。
 * env 参数可注入（测试用）——默认读 process.env。
 */
export function resolveRealProviderConfig(
  env: NodeJS.ProcessEnv = process.env,
): RealProviderConfig | undefined {
  const apiKey = (env['HARNESS_LLM_API_KEY'] ?? '').trim();
  const baseUrlRaw = (env['HARNESS_LLM_BASE_URL'] ?? '').trim();
  const modelRaw = (env['HARNESS_LLM_MODEL'] ?? '').trim();

  if (apiKey === '' && baseUrlRaw === '') return undefined;

  return {
    apiKey,
    baseUrl: baseUrlRaw === '' ? DEFAULT_BASE_URL : baseUrlRaw,
    model: modelRaw === '' ? DEFAULT_MODEL : modelRaw,
  };
}
