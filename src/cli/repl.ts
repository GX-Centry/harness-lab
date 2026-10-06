/**
 * REPL 外壳（w17）—— 交互模式的「壳」：readline 接线、信号处理、渲染循环。
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 芯 / 壳的分工（可测性设计的落地）                                     │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 *   芯    app.handleLine   一行输入 → CliOutput 异步流（纯逻辑，可测）
 *   壳    本文件          迭代输入流、渲染输出、管理取消与退出
 *                         （终端交互不可测——刻意做薄，一切可测逻辑在芯）
 *
 * 输入循环为什么是 for-await：readline 接口是异步可迭代对象（终端回车 =
 * 推一行），天然串行——一行处理完（含整轮工具调用与渲染）才会推下一行，
 * 并发控制无从谈起（也不该有）。
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 权限确认为什么能「插队」：rl.question 的消费机制                       │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * 确认对话发生在「芯处理一行」的**中途**（工具执行前的权限门调用）。
 * 此刻 readline 的异步迭代器正停在循环体内（不在等行），而 rl.question
 * 激活时会设置内部的一次性回调：此后输入行由该回调消费、**不产生 'line'
 * 事件**——迭代器与问答互不干扰（单一输入流，无第二个 readline 实例）。
 *
 * Ctrl+C（SIGINT）双态语义：
 *   运行中 → 请求取消当前 query（abort → Loop 走协作取消路径 → 终态行
 *            显示「已取消」——取消也是管道的一部分，不是崩掉）；
 *   空闲中 → 第一次提示、第二次退出（防误触）。
 */

import type { Interface } from 'node:readline';
import type { ConfirmHandler } from '../permission/gate.ts';
import type { CliApp } from './app.ts';
import { createCliRenderer, formatResumeReport } from './render.ts';

// ===========================================================================
// §1 错误显示（两种模式共用——同一事实同一表述）
// ===========================================================================

/** 把任意异常格式化为单行显示文本 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ===========================================================================
// §2 权限确认通道（依赖倒置的产出）
// ===========================================================================

/**
 * 哨兵注入：向 readline 写一个换行，自触发并清理悬挂的一次性回调
 * （question 的 _questionCallback）。「尽力而为」——rl 已被 close 时
 * 悬挂回调随接口一并丢弃、无需清理，此时注入静默跳过。
 * 为什么用 try/catch 而不是查 closed 属性：Node 的 Interface 类型未公开它。
 */
function writeSentinel(rl: Interface): void {
  try {
    rl.write('\n');
  } catch {
    // rl 已关闭：回调已随 close 丢弃，无需清理
  }
}

/**
 * readline 确认通道：PermissionGate 只认 ConfirmHandler 契约
 * （(request) => Promise<boolean>），「怎么问」由外壳决定——本函数就是
 * 终端形态的展开（Web 形态见 placeholders/web-sse.ts 的 AsyncConfirmationBroker，
 * 同一契约的另一种展开）。
 *
 * 参数是「rl 提供者」而非 rl 实例：REPL 模式复用输入循环的单实例；
 * 单次模式（-p）懒创建。「是否可交互」（stdin.isTTY）判定与三态选择见
 * main.ts——本函数只在交互终端下被装配。
 *
 * ┌───────────────────────────────────────────────────────────────┐
 * │ 超时悬挂的清理（readline 深水区——真实踩过的坑）                  │
 * └───────────────────────────────────────────────────────────────┘
 *
 * PermissionGate 用 Promise.race 做超时（超时 = 拒绝），但 race 结束后
 * 本函数的 Promise **仍然悬挂**；更要命的是 readline 内部的一次性回调
 * （question 的 _questionCallback）也仍然挂着——此后用户键入的任何一行
 * 都会被这个悬挂回调截获（不产生 'line' 事件），被无声吞掉。
 *
 * 清理手段：本地注册与 gate **同源同值**的超时（gate 的 timer 注册更早
 * → 同 tick 先判定），到点后 resolve(false)（结果已无人消费——gate 已
 * 结案）并注入一个换行「哨兵行」自触发回调：answer = '' → 判定 false
 * → 回调消费完毕、_questionCallback 清空。此后用户输入恢复正常（哨兵
 * 本身只产生一个无害空行）。
 *
 * 空回车 / 非 y = 拒绝（fail-safe 默认——与 PermissionGate 缺省策略一致）。
 * 前置换行：确认对话可能插在流式文本之后（行未闭合），保证提问从新行开始。
 */
export function createReadlineConfirm(getRl: () => Interface, timeoutMs: number): ConfirmHandler {
  return (request) =>
    new Promise<boolean>((resolve) => {
      const rl = getRl();
      let done = false;

      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve(false); // gate 已按超时结案；这里只为给 Promise 一个 settle 姿态
        writeSentinel(rl); // 哨兵：自触发并清理悬挂的 _questionCallback
      }, timeoutMs);

      rl.question(
        `\n  [权限] ${request.toolName}（${request.risk}）需要确认？[y/N] `,
        (answer) => {
          if (done) return; // 哨兵行自身到达（超时路径）——已处理，丢弃
          done = true;
          clearTimeout(timer);
          resolve(/^y(es)?$/i.test(answer.trim()));
        },
      );
    });
}

// ===========================================================================
// §3 单次模式（-p）：渲染循环的最简形态
// ===========================================================================

/**
 * 跑一条 query 并渲染到 write（不循环、不显示 prompt）。
 *
 * 与 REPL 共用同一条渲染路径（createCliRenderer）——差别只在「一行」与
 * 「多行」。lab 幕 I 与脚本化冒烟直接复用本函数（write 注入收集器即可）。
 * signal 取消 → Loop 正常收敛为 aborted 终态（不抛——终态行会显示「已取消」）。
 */
export async function runOnce(options: {
  readonly app: CliApp;
  readonly prompt: string;
  readonly signal: AbortSignal;
  readonly write: (text: string) => void;
}): Promise<void> {
  const { app, prompt, signal, write } = options;
  const renderer = createCliRenderer(write);
  if (app.resumeReport !== undefined) write(`${formatResumeReport(app.resumeReport)}\n`);
  for await (const output of app.handleLine(prompt, signal)) {
    renderer.render(output);
  }
  renderer.endTurn();
}

// ===========================================================================
// §4 交互模式：REPL 主循环
// ===========================================================================

export interface ReplOptions {
  readonly app: CliApp;
  /**
   * 已创建的 readline 接口（**在 main 创建**：确认通道与输入循环必须挂在
   * 同一条输入流上——单一输入是交互模型的核心约束，两个实例会互相抢行）。
   */
  readonly rl: Interface;
  /**
   * 输出通道（缺省 process.stdout——rl 的 prompt 也写在它上面，保持同流）。
   * 与 runOnce 对齐的注入口：渲染路径的可测性不来自本函数（它不可测），
   * 而来自 render.ts——这里的注入只为「同一条渲染路径」的复用形态。
   */
  readonly write?: (text: string) => void;
  /** 提示符（缺省 '> '） */
  readonly prompt?: string;
}

/**
 * 启动 REPL：横幅 → 逐行消费 → 每行渲染 → 收尾。
 * 返回时机：/exit 或 /quit 输入、Ctrl+D（EOF）、或「两次 Ctrl+C」关闭 rl。
 */
export async function startRepl(options: ReplOptions): Promise<void> {
  const { app, rl } = options;
  const write =
    options.write ??
    ((text: string): void => {
      process.stdout.write(text);
    });
  const renderer = createCliRenderer(write);

  // ---- 启动横幅：会话身份 + 恢复报告（若有）+ 使用提示 ----
  write(`harness-lab · 会话 ${app.sessionId}\n`);
  if (app.resumeReport !== undefined) {
    write(`${formatResumeReport(app.resumeReport)}\n`);
  }
  write('（/exit 退出 · Ctrl+C 取消当前对话 · /help 查看命令 · /mode 切换权限模式）\n');

  // ---- 取消/退出状态（壳的私有状态，芯完全不知情）----
  let activeQuery: AbortController | undefined;
  let exitConfirmed = false;

  rl.on('SIGINT', () => {
    if (activeQuery !== undefined && !activeQuery.signal.aborted) {
      // 运行中：第一次 Ctrl+C = 请求取消（Loop 收敛为 aborted 终态后回到空闲）
      activeQuery.abort();
      // 悬挂确认的清理（与 createReadlineConfirm 的超时哨兵同理）：此刻可能
      // 正有一个 question 挂着（用户没答就按了 Ctrl+C）——注入哨兵行自触发
      // 其回调，把 readline 的一次性回调清掉；无悬挂时它只是一行无害空输入
      // （后果：迭代器多收一个空行，被忽略）。
      writeSentinel(rl);
      write('\n（已请求取消当前对话——等待终态行）\n');
      return;
    }
    if (exitConfirmed) {
      rl.close(); // 空闲中第二次 Ctrl+C：确认退出
      return;
    }
    exitConfirmed = true;
    write('\n（再按一次 Ctrl+C 退出）\n');
  });

  rl.setPrompt(options.prompt ?? '> ');
  rl.prompt();

  for await (const line of rl) {
    exitConfirmed = false; // 新输入到来 → 退出确认复位
    const input = line.trim();

    // 退出的本地形态：不经过芯（不是命令，是壳的循环控制词）
    if (input === '/exit' || input === '/quit') break;

    if (input !== '') {
      const controller = new AbortController();
      activeQuery = controller;
      try {
        for await (const output of app.handleLine(input, controller.signal)) {
          renderer.render(output);
        }
      } catch (error) {
        // 致命异常（如 provider_error）不杀会话：显示、回到提示符、继续
        renderer.endTurn();
        write(`✗ ${describeError(error)}\n`);
      } finally {
        activeQuery = undefined;
      }
      renderer.endTurn();
    }

    rl.prompt();
  }
}
