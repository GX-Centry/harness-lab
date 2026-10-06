/**
 * 环境预检（preflight）—— 「部署前的体检」：启动/部署阶段先观察这台机器。
 *
 * ===========================================================================
 * 必答问题：为什么需要预检？（问题 3 的修复本体）
 * ===========================================================================
 * 真实使用中踩到的坑都不是「代码 bug」，而是「环境错配」——在用户机器上
 * 才暴露、在本机开发时永远看不到：
 *   - Node 太老：node:sqlite 不存在 → 进程在 import 阶段就崩（栈全是
 *     ERR_UNKNOWN_BUILTIN_MODULE，对用户毫无可读性）；
 *   - 没有 bash / git：模型或演示流程想执行 shell / 版本操作时才失败，
 *     错误信息与根因隔了三层；
 *   - 全局 api-key 冲突：用户设了 OPENAI_API_KEY 以为 harness 会用，
 *     实际 harness 只认 HARNESS_LLM_API_KEY → 悄悄跑离线演示，困惑。
 * 预检把这些问题**前置到启动阶段**：error 阻止启动并解释原因，warn 打
 * 一行提示，ok 静默。`pnpm preflight` 输出完整报告。
 *
 * ---------------------------------------------------------------------------
 * 硬约束：本模块**绝不能** import session/store.ts（或任何依赖 node:sqlite
 * 的模块）。原因：旧 Node 下 import node:sqlite 会在**模块加载期**直接抛出
 * 未捕获异常——进程连「友好报错」的机会都没有。preflight 入口只依赖本文件
 * （+ node:os / node:child_process），因此哪怕 Node 太老也能跑出可读报告。
 *
 * 依赖方向：preflight.ts → node:os / node:child_process（Node 标准库）。
 * 本文件零项目内依赖——这是刻意的（见上）。可测试性：全部检查函数接受
 * 注入参数（版本串 / env / 命令探测器），无隐式全局读取。
 */

import { execFile } from 'node:child_process';
import { arch as osArch, platform as osPlatform, release as osRelease } from 'node:os';

// ===========================================================================
// §1 报告结构
// ===========================================================================

export type PreflightStatus = 'ok' | 'warn' | 'error';

/** 单项检查结果（error 阻止启动；warn 提示；ok 静默/展示） */
export interface PreflightCheck {
  readonly id: string;
  /** 人类可读标题（preflight 报告与启动提示共用） */
  readonly title: string;
  readonly status: PreflightStatus;
  /** 检测到的实际值（是什么） */
  readonly detail: string;
  /** 处置建议（怎么办；仅 warn/error 有） */
  readonly hint?: string;
}

export interface PreflightReport {
  readonly checks: readonly PreflightCheck[];
  /** 最严重状态（调用方据此决定：阻止 / 提示 / 静默） */
  readonly worst: PreflightStatus;
}

function worstOf(checks: readonly PreflightCheck[]): PreflightStatus {
  if (checks.some((c) => c.status === 'error')) return 'error';
  if (checks.some((c) => c.status === 'warn')) return 'warn';
  return 'ok';
}

// ===========================================================================
// §2 单项检查（全部纯函数——注入输入，便于测试穷举）
// ===========================================================================

/** 解析 'v22.5.0' 形态的版本串（解析失败返回 undefined——不猜） */
export function parseNodeVersion(version: string): { major: number; minor: number } | undefined {
  const match = /^v?(\d+)\.(\d+)/.exec(version.trim());
  if (match === null) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return undefined;
  return { major, minor };
}

/**
 * Node 版本检查。三档（与 package.json 的 engines 声明 >= 26 对齐）：
 *   < 22.5      → error：node:sqlite 在此前不存在，会话存储无法启动；
 *   22.5 ~ 25   → warn：能跑但低于 engines 声明——可能缺新 API；
 *   26 ~ 27     → ok：验证基线区间；
 *   >= 28       → warn：超出验证范围（未来版本未测）。
 */
export function checkNodeVersion(version: string): PreflightCheck {
  const parsed = parseNodeVersion(version);
  if (parsed === undefined) {
    return {
      id: 'node',
      title: 'Node 版本',
      status: 'warn',
      detail: `无法解析版本串 "${version}"`,
      hint: '项目要求 Node >= 26（内置 node:sqlite 依赖）',
    };
  }
  const { major, minor } = parsed;
  if (major < 22 || (major === 22 && minor < 5)) {
    return {
      id: 'node',
      title: 'Node 版本',
      status: 'error',
      detail: `${version}（过旧）`,
      hint: 'node:sqlite 从 22.5 才存在——本项目会话存储无法启动。请升级到 Node 26+（nvm / 官网安装包）',
    };
  }
  if (major < 26) {
    return {
      id: 'node',
      title: 'Node 版本',
      status: 'warn',
      detail: `${version}（低于项目声明）`,
      hint: 'package.json engines 要求 >= 26——部分 API 可能缺失，建议升级',
    };
  }
  if (major >= 28) {
    return {
      id: 'node',
      title: 'Node 版本',
      status: 'warn',
      detail: `${version}（超出验证范围）`,
      hint: '该项目在 Node 26.x 上验证——更新的主版本可能存在未预期的行为变化',
    };
  }
  return { id: 'node', title: 'Node 版本', status: 'ok', detail: version };
}

/**
 * 操作系统 / 机型检查（信息性——永远 ok，但把「这台机器是什么」写进
 * 报告：Windows 上的 bash 缺失等问题在报告里一眼可对照）。
 */
export function checkPlatform(
  platform: string = osPlatform(),
  release: string = osRelease(),
  cpuArch: string = osArch(),
): PreflightCheck {
  const note =
    platform === 'win32'
      ? 'Windows：bash 可能不可用（见下一条）；路径差异由 Node path API 抹平'
      : '类 Unix：bash 通常可用';
  return {
    id: 'platform',
    title: '操作系统与机型',
    status: 'ok',
    detail: `${platform} ${release} · ${cpuArch}——${note}`,
  };
}

/** 命令可用性检查（bash / git 等；缺失只 warn——harness 核心不依赖它们） */
export function commandCheck(id: string, title: string, exists: boolean, why: string): PreflightCheck {
  if (exists) return { id, title, status: 'ok', detail: '可用' };
  return {
    id,
    title,
    status: 'warn',
    detail: '未找到',
    hint: `${why}（非必需——harness 核心不依赖它）`,
  };
}

// ---------------------------------------------------------------------------
// 环境变量检查（问题 3 的「全局 api-key 冲突」场景）
// ---------------------------------------------------------------------------

/** harness 自己认的模型配置变量（与 llm/real-provider.ts 的约定一致） */
export const HARNESS_ENV_KEYS = {
  apiKey: 'HARNESS_LLM_API_KEY',
  baseUrl: 'HARNESS_LLM_BASE_URL',
  model: 'HARNESS_LLM_MODEL',
} as const;

/** 常见的「全局 api-key」变量（用户以为 harness 会自动用——实际不会） */
export const COMMON_GLOBAL_KEY_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY'] as const;

/**
 * 环境变量检查（返回 0~2 项）。判定规则与 llm/real-provider.ts 对齐
 * （那里是**唯一判定源**——本模块只是「报告器」，不做第二个判定器）：
 *   1. 模型来源配置态：API_KEY 或 BASE_URL 任一存在 → 真实 API 模式（ok；
 *      缺省项自动补全）；两者都缺 → 离线演示（ok——预期行为）；**只设了
 *      MODEL** → warn（真实模式未启用，该值会被忽略——用户以为配了实际没配）；
 *   2. 全局 key 冲突：设置了常见全局 key 但没设 HARNESS_LLM_API_KEY → warn
 *      （用户以为会自动生效，实际不会读取）；显式设置 → ok（显式优先）。
 */
export function checkEnvConflicts(
  env: Readonly<Record<string, string | undefined>> = process.env,
): PreflightCheck[] {
  const checks: PreflightCheck[] = [];
  const read = (key: string): string => (env[key] ?? '').trim();

  const key = read(HARNESS_ENV_KEYS.apiKey);
  const baseUrl = read(HARNESS_ENV_KEYS.baseUrl);
  const model = read(HARNESS_ENV_KEYS.model);

  if (key !== '' || baseUrl !== '') {
    checks.push({
      id: 'llm-config',
      title: '模型来源配置',
      status: 'ok',
      detail: 'API_KEY / BASE_URL 已配置——真实 API 模式（缺省项自动补全）',
    });
  } else if (model !== '') {
    checks.push({
      id: 'llm-config',
      title: '模型来源配置',
      status: 'warn',
      detail: `只设置了 ${HARNESS_ENV_KEYS.model}——会被忽略（真实模式需 API_KEY 或 BASE_URL 至少其一）`,
      hint: `补上 ${HARNESS_ENV_KEYS.apiKey} 或 ${HARNESS_ENV_KEYS.baseUrl}——否则仍按离线演示运行`,
    });
  } else {
    checks.push({
      id: 'llm-config',
      title: '模型来源配置',
      status: 'ok',
      detail: '未配置——离线演示模式（预期行为；.env 可接入真实 API）',
    });
  }

  const globalKeys = COMMON_GLOBAL_KEY_KEYS.filter((name) => read(name) !== '');
  if (globalKeys.length > 0 && key === '') {
    checks.push({
      id: 'global-key',
      title: '全局 api-key 冲突',
      status: 'warn',
      detail: `检测到全局变量 ${globalKeys.join(' / ')}——但 harness 不会自动读取它们`,
      hint: `harness 不会自动读取全局 key——如需鉴权请显式设置 ${HARNESS_ENV_KEYS.apiKey}（或在 .env 中配置）`,
    });
  } else if (globalKeys.length > 0) {
    checks.push({
      id: 'global-key',
      title: '全局 api-key 冲突',
      status: 'ok',
      detail: `全局 ${globalKeys.join(' / ')} 存在；harness 使用显式配置的 ${HARNESS_ENV_KEYS.apiKey}`,
    });
  }

  return checks;
}

// ===========================================================================
// §3 编排与格式化
// ===========================================================================

/** 命令探测器缺省实现：Windows 用 where、其余用 which（一次 execFile） */
function defaultCommandExists(command: string): Promise<boolean> {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve) => {
    try {
      execFile(probe, [command], { timeout: 3_000, windowsHide: true }, (error) => {
        resolve(error === null);
      });
    } catch {
      resolve(false); // execFile 同步抛（极端环境）——按「不存在」处理
    }
  });
}

export interface PreflightOptions {
  readonly nodeVersion?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** 命令探测器（测试注入；缺省 where/which） */
  readonly commandExists?: (command: string) => Promise<boolean>;
}

/** 跑全部检查（命令探测并行——总耗时 ≈ 最慢一项） */
export async function runPreflight(options: PreflightOptions = {}): Promise<PreflightReport> {
  const probe = options.commandExists ?? defaultCommandExists;
  const [bashExists, gitExists] = await Promise.all([probe('bash'), probe('git')]);

  const checks: PreflightCheck[] = [
    checkNodeVersion(options.nodeVersion ?? process.version),
    checkPlatform(),
    commandCheck('bash', 'bash 可用性', bashExists, '涉及 shell 的演示 / 流程会失败'),
    commandCheck('git', 'git 可用性', gitExists, '涉及版本管理的操作会失败'),
    ...checkEnvConflicts(options.env ?? process.env),
  ];
  return { checks, worst: worstOf(checks) };
}

/** 格式化为多行报告（preflight 入口与「error 阻止启动」共用——同一事实同一表述） */
export function formatPreflightReport(report: PreflightReport): string {
  const mark: Record<PreflightStatus, string> = { ok: '[ok]', warn: '[warn]', error: '[error]' };
  const lines = [`环境预检报告（${report.checks.length} 项，最严重：${report.worst}）:`];
  for (const check of report.checks) {
    lines.push(`  ${mark[check.status].padEnd(8)}${check.title}：${check.detail}`);
    if (check.hint !== undefined) lines.push(`          → ${check.hint}`);
  }
  return lines.join('\n');
}
