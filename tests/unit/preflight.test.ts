/**
 * 环境预检（preflight）单元测试 —— 「部署前先观察这台机器」的判定矩阵。
 *
 * 背景（w18，问题 3）：真实使用中踩的坑不是代码 bug 而是环境错配
 * （Node 太老 / 没 bash / 全局 api-key 冲突）。本测试锁定预检模块的
 * 全部判定承诺——它决定「启动被阻止 / 提示 / 静默」三态，判定错了
 * 要么拦住健康用户，要么放过会崩的用户：
 *
 * 覆盖矩阵（全部注入输入——不依赖跑测试这台机器的真实环境）：
 *   ① Node 版本四档：<22.5 error（node:sqlite 不存在）/ 22.5~25 warn
 *      （低于 engines 声明）/ 26~27 ok / >=28 warn（超出验证范围）；
 *      版本串解析失败 → warn（不崩、不猜）；
 *   ② 平台检查：win32 与类 Unix 两种说明分支；永远 ok（信息性）；
 *   ③ 命令检查：缺失只 warn 不 error（harness 核心不依赖 bash/git）；
 *   ④ 环境变量冲突：key / baseUrl 任一即真实模式（与 real-provider.ts 判定
 *      对齐）/ 全缺离线 / 只设 model 被忽略 + 全局 key 存在两态
 *      （未显式配置时 warn「不会自动读取」）；
 *   ⑤ 编排：注入假探测器——bash 缺失 → worst=warn；
 *   ⑥ 报告格式：计数、最严重级别、逐项标记、hint 箭头缩进。
 */

import { describe, expect, it } from 'vitest';
import {
  checkEnvConflicts,
  checkNodeVersion,
  checkPlatform,
  commandCheck,
  COMMON_GLOBAL_KEY_KEYS,
  formatPreflightReport,
  HARNESS_ENV_KEYS,
  parseNodeVersion,
  runPreflight,
} from '../../src/preflight.ts';

// ---------------------------------------------------------------------------
// §1 Node 版本解析（宽容：带 v 前缀 / 前后空白 / 两段版本号；垃圾输入不猜）
// ---------------------------------------------------------------------------

describe('parseNodeVersion', () => {
  it('标准三段版本串（带 v 前缀）', () => {
    expect(parseNodeVersion('v26.8.1')).toEqual({ major: 26, minor: 8 });
  });

  it('两段版本串（process.versions 之外的调用方可能只给 major.minor）', () => {
    expect(parseNodeVersion('22.5')).toEqual({ major: 22, minor: 5 });
  });

  it('容忍前后空白与省略 v 前缀', () => {
    expect(parseNodeVersion('  26.0.0  ')).toEqual({ major: 26, minor: 0 });
  });

  it('垃圾输入返回 undefined（不猜、不崩溃）', () => {
    expect(parseNodeVersion('not-a-version')).toBeUndefined();
    expect(parseNodeVersion('')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §2 Node 版本四档判定（与 package.json engines >=26 对齐）
// ---------------------------------------------------------------------------

describe('checkNodeVersion', () => {
  it('<22.5 → error（node:sqlite 不存在，会话存储无法启动）', () => {
    const check = checkNodeVersion('v18.17.0');
    expect(check.status).toBe('error');
    expect(check.detail).toContain('v18.17.0');
    expect(check.hint).toContain('22.5');
  });

  it('22.4 是 error 边界（22.5 之前都不行）', () => {
    expect(checkNodeVersion('v22.4.0').status).toBe('error');
  });

  it('22.5 降为 warn（能跑但低于 engines 声明）', () => {
    const check = checkNodeVersion('v22.5.0');
    expect(check.status).toBe('warn');
    expect(check.hint).toContain('>= 26');
  });

  it('24.x → warn', () => {
    expect(checkNodeVersion('v24.9.0').status).toBe('warn');
  });

  it('26.x → ok（验证基线）', () => {
    const check = checkNodeVersion('v26.8.1');
    expect(check.status).toBe('ok');
    expect(check.hint).toBeUndefined();
  });

  it('27.x → ok', () => {
    expect(checkNodeVersion('v27.0.0').status).toBe('ok');
  });

  it('>=28 → warn（超出验证范围）', () => {
    const check = checkNodeVersion('v28.0.0');
    expect(check.status).toBe('warn');
    expect(check.hint).toContain('26.x');
  });

  it('无法解析的版本串 → warn（报告可读性优先于崩溃）', () => {
    const check = checkNodeVersion('weird');
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('weird');
  });
});

// ---------------------------------------------------------------------------
// §3 平台检查（信息性——永远 ok，但把「这台机器是什么」写进报告）
// ---------------------------------------------------------------------------

describe('checkPlatform', () => {
  it('win32：报告 Windows 的 bash 风险提示', () => {
    const check = checkPlatform('win32', '10.0.19045', 'x64');
    expect(check.status).toBe('ok');
    expect(check.detail).toContain('win32');
    expect(check.detail).toContain('x64');
    expect(check.detail).toContain('Windows');
  });

  it('类 Unix：标注 bash 通常可用', () => {
    const check = checkPlatform('darwin', '23.0.0', 'arm64');
    expect(check.status).toBe('ok');
    expect(check.detail).toContain('类 Unix');
    expect(check.detail).toContain('arm64');
  });
});

// ---------------------------------------------------------------------------
// §4 命令检查（缺失只 warn——harness 核心不依赖 bash/git）
// ---------------------------------------------------------------------------

describe('commandCheck', () => {
  it('命令可用 → ok', () => {
    const check = commandCheck('git', 'git 可用性', true, '版本操作会失败');
    expect(check.status).toBe('ok');
    expect(check.detail).toBe('可用');
  });

  it('命令缺失 → warn，hint 说明影响面与「非必需」', () => {
    const check = commandCheck('bash', 'bash 可用性', false, 'shell 演示会失败');
    expect(check.status).toBe('warn');
    expect(check.hint).toContain('shell 演示会失败');
    expect(check.hint).toContain('非必需');
  });
});

// ---------------------------------------------------------------------------
// §5 环境变量冲突（问题 3 的「全局 api-key」场景）
// ---------------------------------------------------------------------------

/** 构造一份干净的 env（全空——显式提供所有相关键，避免继承真实 process.env） */
function cleanEnv(overrides: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    [HARNESS_ENV_KEYS.apiKey]: undefined,
    [HARNESS_ENV_KEYS.baseUrl]: undefined,
    [HARNESS_ENV_KEYS.model]: undefined,
  };
  for (const key of COMMON_GLOBAL_KEY_KEYS) env[key] = undefined;
  return { ...env, ...overrides };
}

describe('checkEnvConflicts', () => {
  it('key + baseUrl 已配置 → llm-config ok（真实 API 模式）', () => {
    const checks = checkEnvConflicts(
      cleanEnv({
        [HARNESS_ENV_KEYS.apiKey]: 'sk-test',
        [HARNESS_ENV_KEYS.baseUrl]: 'https://api.example.com/v1',
        [HARNESS_ENV_KEYS.model]: 'deepseek-chat',
      }),
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe('ok');
    expect(checks[0]?.detail).toContain('真实 API');
  });

  it('只填 key 亦启用真实模式（判定与 real-provider 一致：baseUrl 缺省补全）', () => {
    const checks = checkEnvConflicts(cleanEnv({ [HARNESS_ENV_KEYS.apiKey]: 'sk-test' }));
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe('ok');
    expect(checks[0]?.detail).toContain('真实 API');
  });

  it('只填 baseUrl 亦启用真实模式（本地服务无鉴权场景）', () => {
    const checks = checkEnvConflicts(cleanEnv({ [HARNESS_ENV_KEYS.baseUrl]: 'http://127.0.0.1:11434/v1' }));
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe('ok');
    expect(checks[0]?.detail).toContain('真实 API');
  });

  it('只填了 MODEL（真实模式未启用）→ warn：会被忽略', () => {
    const checks = checkEnvConflicts(cleanEnv({ [HARNESS_ENV_KEYS.model]: 'deepseek-chat' }));
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe('warn');
    expect(checks[0]?.detail).toContain(HARNESS_ENV_KEYS.model);
    expect(checks[0]?.hint).toContain(HARNESS_ENV_KEYS.apiKey);
  });

  it('全缺 → ok（离线演示是预期行为，不打扰用户）', () => {
    const checks = checkEnvConflicts(cleanEnv());
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe('ok');
    expect(checks[0]?.detail).toContain('离线演示');
  });

  it('空白串视为未设置（.env 里留空行的常见形态）——baseUrl 仍启用真实模式', () => {
    const checks = checkEnvConflicts(
      cleanEnv({
        [HARNESS_ENV_KEYS.apiKey]: '   ',
        [HARNESS_ENV_KEYS.baseUrl]: 'https://api.example.com/v1',
      }),
    );
    expect(checks[0]?.status).toBe('ok');
    expect(checks[0]?.detail).toContain('真实 API');
  });

  it('全局 key 存在但未显式配置 → 追加 warn（「不会自动读取它们」）', () => {
    const checks = checkEnvConflicts(cleanEnv({ OPENAI_API_KEY: 'sk-global' }));
    expect(checks).toHaveLength(2);
    const global = checks.find((c) => c.id === 'global-key');
    expect(global?.status).toBe('warn');
    expect(global?.detail).toContain('OPENAI_API_KEY');
    expect(global?.detail).toContain('不会自动读取');
    expect(global?.hint).toContain(HARNESS_ENV_KEYS.apiKey);
  });

  it('全局 key 与显式配置并存 → ok（显式优先）', () => {
    const checks = checkEnvConflicts(
      cleanEnv({
        OPENAI_API_KEY: 'sk-global',
        ANTHROPIC_API_KEY: 'sk-global-2',
        [HARNESS_ENV_KEYS.apiKey]: 'sk-explicit',
      }),
    );
    const global = checks.find((c) => c.id === 'global-key');
    expect(global?.status).toBe('ok');
    expect(global?.detail).toContain('显式配置');
  });

  it('无全局 key 且无显式配置 → 不产生 global-key 项（不打扰）', () => {
    const checks = checkEnvConflicts(cleanEnv());
    expect(checks.some((c) => c.id === 'global-key')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §6 编排（注入假探测器——命令探测不跑真实 where/which）
// ---------------------------------------------------------------------------

describe('runPreflight', () => {
  const allExist = async (): Promise<boolean> => true;
  const noneExist = async (): Promise<boolean> => false;

  it('命令齐全 + 环境干净 → worst=ok，5 项检查', async () => {
    const report = await runPreflight({ nodeVersion: 'v26.8.1', env: cleanEnv(), commandExists: allExist });
    expect(report.checks).toHaveLength(5);
    expect(report.worst).toBe('ok');
  });

  it('bash 缺失 → worst=warn（核心不依赖 shell——不阻止启动）', async () => {
    const report = await runPreflight({
      nodeVersion: 'v26.8.1',
      env: cleanEnv(),
      commandExists: async (command) => command === 'git',
    });
    expect(report.worst).toBe('warn');
    expect(report.checks.find((c) => c.id === 'bash')?.status).toBe('warn');
    expect(report.checks.find((c) => c.id === 'git')?.status).toBe('ok');
  });

  it('Node 过旧 → worst=error（调用方据此阻止启动）', async () => {
    const report = await runPreflight({ nodeVersion: 'v18.0.0', env: cleanEnv(), commandExists: allExist });
    expect(report.worst).toBe('error');
    expect(report.checks.find((c) => c.id === 'node')?.status).toBe('error');
  });

  it('error 光临即最严重（warn 与 error 并存取 error）', async () => {
    const report = await runPreflight({
      nodeVersion: 'v18.0.0',
      env: cleanEnv({ OPENAI_API_KEY: 'sk-global' }),
      commandExists: noneExist,
    });
    expect(report.worst).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// §7 报告格式（preflight 入口与「error 阻止启动」共用——同一事实同一表述）
// ---------------------------------------------------------------------------

describe('formatPreflightReport', () => {
  it('标题含项数与最严重级别；逐项带标记；hint 箭头缩进', async () => {
    const report = await runPreflight({
      nodeVersion: 'v18.0.0',
      env: cleanEnv(),
      commandExists: async (command) => command === 'git',
    });
    const text = formatPreflightReport(report);
    expect(text).toContain('环境预检报告（5 项，最严重：error）');
    expect(text).toContain('[error]');
    expect(text).toContain('[warn]');
    expect(text).toContain('[ok]');
    expect(text).toMatch(/\n {10}→ /); // hint 行：缩进 + 箭头
  });
});
