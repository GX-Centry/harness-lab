/**
 * CLI 渲染层（w17）——「壳」中可独立的一段：CliOutput 流 → 终端文本。
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 为什么独立成层（而不是散在 repl.ts 里）                                │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 *   1. 芯（app.handleLine）与渲染解耦：测试直接断言事件流，不碰终端；
 *   2. 渲染是**有状态**的——「行开/行闭」管理只有一处定义：
 *        text_delta  原地增量写（不换行）→ 标记行为「开」；
 *        工具/命令/统计行先补换行再整行输出 → 标记为「闭」。
 *      流式文本与整行提示的混排规则就藏在这个小状态机里。
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 渲染的输入词汇 = LoopEvent 全集（一条不落，多一条不加）                │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 *   text_delta      原地写（流式效果）
 *   thinking_delta  忽略（演示 Provider 不产生；真实模型可渲染为暗色——演进点）
 *   turn_started    忽略（轮次信息汇聚在终态统计行；逐轮提示会淹没对话）
 *   tool_started    ▸ 单行：工具名 + 参数摘要
 *   tool_finished   ✓/✗ 单行：工具名 + 结果首行摘要
 *   completed       统计行：轮次 + 用量 + 非正常终止原因
 *
 * 终端可读性纪律：工具行永远单行（多行参数/结果截断取首行）——
 * 对话主体（text_delta）才是主角，工具活动只是脚注。
 */

import type { ResumeInfo } from '../session/session-manager.ts';
import type { LoopStopReason } from '../types.ts';
import type { CliOutput } from './app.ts';

// ===========================================================================
// §1 小工具（行纪律的执行者）
// ===========================================================================

/** 单行截断：取首行 + 去空白 + 超长截断（终端单行可读性优先） */
function truncate(text: string, max: number): string {
  const firstLine = (text.split('\n', 1)[0] ?? '').trim();
  return firstLine.length <= max ? firstLine : `${firstLine.slice(0, max)}…`;
}

/** 参数摘要：JSON 一行 + 截断；不可序列化时给出行内提示（不能因为渲染崩掉） */
function briefArgs(args: unknown): string {
  if (args === undefined || args === null) return '';
  try {
    const text = JSON.stringify(args);
    return text === undefined ? '' : truncate(text, 60);
  } catch {
    return '[参数无法序列化]';
  }
}

/** 非正常终止的括注（completed 无括注——正常是默认态） */
function stopNote(reason: LoopStopReason): string {
  switch (reason) {
    case 'completed':
      return '';
    case 'max_turns':
      return '（达到最大轮次）';
    case 'aborted':
      return '（已取消）';
    case 'error':
      return '（出错终止）';
  }
}

// ===========================================================================
// §2 渲染器（有状态闭包）
// ===========================================================================

export interface CliRenderer {
  /** 渲染一个输出事件（状态随之推进：行开/行闭） */
  render(output: CliOutput): void;
  /**
   * 一次 handleLine 流结束后的收尾：把未闭合的行补上换行。
   * 壳在「下一个 prompt 之前」调用——保证提示符永远从新行开始。
   */
  endTurn(): void;
}

/**
 * 创建渲染器。write 是唯一的输出通道（repl 绑 rl.output、单次模式绑
 * process.stdout、测试绑数组收集器）——**渲染的可测性来自这个注入口**。
 */
export function createCliRenderer(write: (text: string) => void): CliRenderer {
  // 「当前行是否已有未换行的内容」——渲染器唯一的状态
  let lineOpen = false;

  const newlineIfOpen = (): void => {
    if (lineOpen) {
      write('\n');
      lineOpen = false;
    }
  };

  /** 整行输出（先收掉未闭合的行，再写内容 + 换行） */
  const line = (text: string): void => {
    newlineIfOpen();
    write(`${text}\n`);
  };

  return {
    render(output) {
      // 斜杠命令的结果文本：总是整行（命令不是流式内容）
      if (output.kind === 'command') {
        line(output.text);
        return;
      }

      const event = output.event;
      switch (event.type) {
        case 'text_delta': {
          // 流式主航道：原地写，不换行（分片到达即渲染——「打字机」的来源）
          write(event.text);
          lineOpen = true;
          break;
        }
        case 'thinking_delta':
          break; // 见文件头：演示模式不产生；真实模型渲染是演进点
        case 'turn_started':
          break; // 见文件头：轮次信息在终态行展示
        case 'tool_started':
          line(`▸ ${event.name}(${briefArgs(event.args)})`);
          break;
        case 'tool_finished':
          line(
            `${event.result.ok ? '✓' : '✗'} ${event.name} → ${truncate(event.result.content, 80)}`,
          );
          break;
        case 'completed': {
          const { result } = event;
          newlineIfOpen();
          write(
            `—— ${result.turns} 轮 · ↑${result.usage.inputTokens} ↓${result.usage.outputTokens} tok` +
              `${stopNote(result.stopReason)}\n`,
          );
          break;
        }
      }
    },
    endTurn: newlineIfOpen,
  };
}

// ===========================================================================
// §3 恢复报告（启动横幅的一部分——壳在两种模式下共用）
// ===========================================================================

/** 把 ResumeInfo 格式化为一行（REPL 横幅与单次模式共用——同一事实同一表述） */
export function formatResumeReport(info: ResumeInfo): string {
  const filled =
    info.filledToolCallIds.length > 0 ? ` · 补位工具调用 ${info.filledToolCallIds.length} 个` : '';
  return (
    `（已恢复会话 ${info.sessionId}：检查点 ${info.checkpointId} · ` +
    `轮次 ${info.turn} · 消息 ${info.messageCount} 条${filled}）`
  );
}
