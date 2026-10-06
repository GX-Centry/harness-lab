/**
 * CLI 入口（w17）—— argv 解析 + 装配 + 两种运行模式。`pnpm dev` / `pnpm chat`。
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 用法                                                                  │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 *   harness-lab [chat]              交互式 REPL（缺省；chat 是显式子命令）
 *   harness-lab --session <id>      指定 / 复用会话（不存在则创建）
 *   harness-lab --continue          继续最近一次会话（与 --session 同传时后者优先）
 *   harness-lab -p "<prompt>"       单次问答后退出（脚本友好；同样支持上面两个参数）
 *   harness-lab --mode <m>          权限模式：manual / semi / auto（w18）
 *   harness-lab --yes               等价 --mode auto（自动批准，旧习惯保留）
 *   harness-lab --help              显示帮助
 *
 * 模型来源：环境变量 / .env（HARNESS_LLM_API_KEY / BASE_URL / MODEL）→ 真实
 * OpenAI 兼容 API；三者皆缺省 → 离线演示规则 Provider（确定性、无网络）。
 *
 * 退出码：0 正常 / 1 参数错误或致命失败（脚本可判别）。
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 本文件为什么这么薄                                                    │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * 一切可测逻辑都在芯（app.ts）与渲染（render.ts）；这里只有三件不可测的
 * 进程级事务：argv 解析、readline 创建（**单实例**：确认通道与 REPL 输入
 * 共用同一条流）、finally 清理。导入本模块 = 启动进程（副作用入口，刻意
 * 不进 index.ts 出口——见 cli/index.ts 的边界说明）。
 */

import { createInterface } from 'node:readline';
import type { Interface } from 'node:readline';
import { defineConfig } from '../config.ts';
import { OpenAICompatibleProvider } from '../llm/openai-compatible-provider.ts';
import { loadDotEnv, resolveRealProviderConfig } from '../llm/real-provider.ts';
import type { ConfirmHandler } from '../permission/gate.ts';
import { describePermissionMode, parsePermissionMode } from '../permission/modes.ts';
import { formatPreflightReport, runPreflight } from '../preflight.ts';
import { resolveStorePath } from '../session/store.ts';
import type { PermissionMode } from '../types.ts';
import { createCliApp } from './app.ts';
import { createReadlineConfirm, describeError, runOnce, startRepl } from './repl.ts';

const USAGE = [
  'harness-lab —— 教学级 Agent Harness CLI（w17）',
  '',
  '用法：',
  '  harness-lab [chat]            交互式 REPL（/exit 退出 · Ctrl+C 取消当前对话）',
  '  harness-lab --session <id>    指定 / 复用会话（不存在则创建）',
  '  harness-lab --continue        继续最近一次会话',
  '  harness-lab -p "<prompt>"     单次问答后退出（脚本友好）',
  '  harness-lab --mode <m>        权限模式：manual 全手动（缺省）/ semi 半自动 / auto 全自动',
  '  harness-lab --yes             等价 --mode auto（无人值守 / 演示——保留旧习惯）',
  '  harness-lab --help            显示本帮助',
  '',
  '模型来源：.env / 环境变量（HARNESS_LLM_API_KEY / BASE_URL / MODEL）→ 真实 API；',
  '          缺省为离线演示规则 Provider。网页壳另有「服务设置」热切换。',
  '权限模式：manual 每步人工确认 / semi 低中风险自动放行 / auto 全部自动；',
  '          运行中可用 /mode 切换；环境变量 HARNESS_PERMISSION_MODE 可设缺省。',
].join('\n');

// ===========================================================================
// §1 argv 解析（手写：参数少，帮助文本即文法）
// ===========================================================================

interface ParsedArgs {
  readonly help: boolean;
  readonly prompt: string | undefined; // -p：单次模式
  readonly sessionId: string | undefined; // --session
  readonly continueLatest: boolean; // --continue
  readonly yes: boolean; // --yes：自动批准权限确认（= --mode auto 别名）
  readonly mode: PermissionMode | undefined; // --mode：初始权限模式
}

/** 解析 argv（只认上面 USAGE 列出的形态；未知参数直接抛——不猜用户意图） */
function parseArgs(argv: readonly string[]): ParsedArgs {
  let help = false;
  let prompt: string | undefined;
  let sessionId: string | undefined;
  let continueLatest = false;
  let yes = false;
  let mode: PermissionMode | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case 'chat': // 显式子命令 = 缺省行为（`pnpm chat` 的语义自明）
        break;
      case '-h':
      case '--help':
        help = true;
        break;
      case '-c':
      case '--continue':
        continueLatest = true;
        break;
      case '-y':
      case '--yes':
        yes = true;
        break;
      case '--mode': {
        const value = argv[i + 1];
        if (value === undefined) throw new Error('--mode 需要取值：manual / semi / auto');
        const parsed = parsePermissionMode(value);
        if (parsed === undefined) {
          throw new Error(`--mode 取值无效：${value}（可选 manual / semi / auto）`);
        }
        mode = parsed;
        i += 1;
        break;
      }
      case '--session': {
        const value = argv[i + 1];
        if (value === undefined) throw new Error('--session 需要一个会话 id');
        sessionId = value;
        i += 1;
        break;
      }
      case '-p':
      case '--prompt': {
        const value = argv[i + 1];
        if (value === undefined) throw new Error('-p 需要一个 prompt 文本');
        prompt = value;
        i += 1;
        break;
      }
      default:
        throw new Error(`未知参数：${arg}`);
    }
  }
  return { help, prompt, sessionId, continueLatest, yes, mode };
}

// ===========================================================================
// §2 主流程
// ===========================================================================

async function main(): Promise<void> {
  // .env 必须先加载（若存在）——任何读 process.env 的逻辑之前（入口时序约定）
  loadDotEnv();

  // ---- 参数（错误 → 帮助 + 非零退出码，不进入装配）----
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`参数错误：${describeError(error)}\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }

  // ---- 环境预检（w18，问题 3）：error 阻止启动 / warn 一行提示 / ok 静默 ----
  // 放在 readline 之前——环境不合格时不进入交互（避免「进去才炸」的体验）。
  // 完整报告用 `pnpm preflight`（同一套检查，展示策略不同）。
  const preflight = await runPreflight();
  if (preflight.worst === 'error') {
    console.error('环境预检未通过——启动已阻止：');
    console.error(formatPreflightReport(preflight));
    console.error('提示：`pnpm preflight` 可随时查看完整报告。');
    process.exitCode = 1;
    return;
  }
  for (const check of preflight.checks) {
    if (check.status === 'warn') {
      console.log(`  [预检] ${check.title}：${check.detail}${check.hint === undefined ? '' : `——${check.hint}`}`);
    }
  }

  // ---- readline 布局（单实例约束 + 激活时序）----
  // REPL 模式：立即创建——输入循环立即需要它（用户的打字是主输入）。
  // 单次模式（-p）：不预创建——stdin 不归对话循环所有；提前建立的 readline
  //   会把管道数据空转消费（'line' 无监听 → 丢弃）并在 EOF 时自动 close，
  //   随后 confirm 的 question 直接抛「readline was closed」（误导为权限异常）。
  const replRl =
    args.prompt === undefined
      ? createInterface({
          input: process.stdin,
          output: process.stdout,
          terminal: process.stdout.isTTY === true,
        })
      : undefined;

  // 确认通道的 readline：REPL 复用输入循环实例；-p 模式懒创建（首个
  // question 才建——交互路径下提问时才需要输入能力，时序无差异）
  let confirmRl: Interface | undefined;
  const getInteractiveRl = (): Interface => {
    if (replRl !== undefined) return replRl;
    confirmRl ??= createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdout.isTTY === true,
    });
    return confirmRl;
  };

  // 模型来源：环境变量（含 .env）有配置 → 真实 OpenAI 兼容 Provider；
  // 否则保持缺省演示规则 Provider（离线确定性地基不变）
  const realConfig = resolveRealProviderConfig();

  // 配置（唯一实例）：confirm 的交互超时需要与 PermissionGate **同源同值**
  // （哨兵清理的时序依据——见 repl.ts 的超时注释），因此显式创建并传递。
  // 真实模式覆盖 defaultModel（Provider 用 req.model 做路由）+ 放宽请求超时
  const config =
    realConfig === undefined
      ? defineConfig()
      : defineConfig({ llm: { defaultModel: realConfig.model, requestTimeoutMs: 120_000 } });

  // ---- 权限模式解析（w18；优先序（后写胜）：配置缺省 < 环境变量 < --yes < --mode）----
  // 与 confirm 通道的关系：auto / semi 的「自动批准」在 PermissionGate 决策链
  // 内部短路（source='mode'，如实留痕），**不经过 confirm 通道**——确认通道只
  // 承载剩下的「真需要问人」的场景。
  const envModeRaw = process.env['HARNESS_PERMISSION_MODE'];
  const envMode = envModeRaw === undefined ? undefined : parsePermissionMode(envModeRaw);
  let permissionMode: PermissionMode = config.permission.mode;
  let modeSource = '配置缺省';
  if (envModeRaw !== undefined && envMode === undefined) {
    console.log(
      `  [权限] HARNESS_PERMISSION_MODE="${envModeRaw}" 无效（可选 manual / semi / auto）——已忽略，按缺省处理`,
    );
  }
  if (envMode !== undefined) {
    permissionMode = envMode;
    modeSource = '环境变量';
  }
  if (args.yes) {
    permissionMode = 'auto';
    modeSource = '--yes';
  }
  if (args.mode !== undefined) {
    permissionMode = args.mode;
    modeSource = '--mode';
  }

  // ---- 确认通道两态（优先序：交互终端 > fail-safe 拒绝）----
  //   1. stdin 是交互终端：readline 问答（真正的人工确认）；
  //   2. 其余（管道 / CI）：恒拒绝——非交互环境无人可问，拒绝是**正确
  //      默认值**（与 PermissionGate「无 confirm = 拒绝」的 fail-safe 一致）。
  // 旧 --yes 分支已删除：它属于「自动化批准」，w18 起统一收敛到权限模式
  // （gate 决策链），确认通道不再承担批准职责——审计原因不再自相矛盾。
  const confirm: ConfirmHandler =
    process.stdin.isTTY === true
      ? createReadlineConfirm(getInteractiveRl, config.permission.confirmTimeoutMs)
      : () => Promise.resolve(false);

  // ---- 装配（唯一 Provider 替换点就在被调用的 createCliApp 内部——app.ts）----
  const app = createCliApp({
    dbPath: resolveStorePath('data/cli.db'),
    config, // 显式传入：装配与确认通道共用同一份配置（单一配置源）
    ...(realConfig === undefined
      ? {}
      : {
          // 真实模式：主世界 + 子代理都用真实 Provider（工厂每子代理新建实例）
          provider: new OpenAICompatibleProvider({ apiKey: realConfig.apiKey, baseUrl: realConfig.baseUrl }),
          subagentProviderFactory: () =>
            new OpenAICompatibleProvider({ apiKey: realConfig.apiKey, baseUrl: realConfig.baseUrl }),
        }),
    sessionId: args.sessionId,
    continueLatest: args.continueLatest,
    confirm,
    permissionMode: permissionMode,
  });

  // ---- 模型来源留痕（一行；REPL 横幅随后——脚本与人都一眼可见）----
  console.log(
    realConfig === undefined
      ? '  [模型] 离线演示（规则 Provider）——.env / HARNESS_LLM_* 可接入真实 API'
      : `  [模型] 真实 API：${realConfig.model} @ ${realConfig.baseUrl}`,
  );
  // ---- 权限模式留痕（含来源：用户一眼知道这次进程为什么是这个姿态）----
  console.log(`  [权限] ${permissionMode}（${modeSource}）—— ${describePermissionMode(permissionMode)}`);

  try {
    if (args.prompt !== undefined) {
      // ---- 单次模式：一条 query 跑完即退（Ctrl+C = 取消该 query）----
      const controller = new AbortController();
      const onSigint = (): void => {
        controller.abort();
      };
      process.on('SIGINT', onSigint);
      try {
        await runOnce({
          app,
          prompt: args.prompt,
          signal: controller.signal,
          write: (text) => {
            process.stdout.write(text);
          },
        });
      } finally {
        process.off('SIGINT', onSigint);
      }
    } else if (replRl !== undefined) {
      // ---- 交互模式：REPL 主循环（内部管理取消与退出）----
      await startRepl({ app, rl: replRl });
    }
  } catch (error) {
    console.error(`✗ 致命错误：${describeError(error)}`);
    process.exitCode = 1;
  } finally {
    replRl?.close(); // 幂等（/exit 路径下已由循环收尾或即将关闭）
    confirmRl?.close(); // -p 模式若创建过确认 readline——一并释放
    app.dispose(); // 幂等（关 SQLite）
  }
}

main().catch((error: unknown) => {
  // 兜底（main 内部已全 catch；此处防未预见路径）——不静默吞掉任何异常
  console.error(`✗ 未捕获错误：${describeError(error)}`);
  process.exitCode = 1;
});
