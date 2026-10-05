/**
 * SkillRunner —— 技能的确定性执行器（「解释器」）。
 *
 * ===========================================================================
 * 执行模型：把声明解释成工具调用序列
 * ===========================================================================
 *
 *   for 每个步骤：
 *     ① resolveArgs(input, 前序结果)  → 得到本次工具调用的参数
 *     ② 构造规范形 ToolCall          → 与模型产生的调用完全同构
 *     ③ dispatcher.dispatch(call)    → 走完整四步链（Hook→权限→执行→Hook）
 *     ④ 检查结果：失败即停（fail-fast）
 *
 * ---------------------------------------------------------------------------
 * 关键设计决策（逐条标注理由）
 * ---------------------------------------------------------------------------
 *
 * 决策①：技能不绕过 Dispatcher。
 *   技能执行工具与模型调用工具走**同一条链**——hook、权限、审计、超时
 *   全部照常生效。如果技能为了「快」直接调 tool.execute()，会绕开权限检查
 *   （高危操作静默执行）与审计（事件缺失）——这是绝不允许的捷径。
 *   代价：多一层事件噪音（工具事件嵌在技能事件里）——可观测层按 queryId
 *   归组即可区分（技能 run 有自己的 queryId 前缀）。
 *
 * 决策②：fail-fast（某步失败 → 立即终止后续步骤）。
 *   确定性编排里步骤间存在数据流依赖（第 2 步的输入来自第 1 步的输出）。
 *   第 1 步失败后继续执行，第 2 步拿到的是残缺输入——产出的「成功」结果
 *   建立在坏数据上，比直接失败更危险。
 *   对照：w13 子代理并发池的部分失败聚合是**不同语义**——那里各子任务是
 *   独立的（互不消费对方输出），一个失败不代表其他无意义。
 *   演进点：需要「尽力而为」语义时给 SkillDefinition 加 onStepError: 'continue'
 *   选项（v1 不做：没有真实需求前不引入双语义）。
 *
 * 决策③：未知工具「执行前整体预检」而不是「跑到才发现」。
 *   若第 3 步引用了不存在的工具，等前 2 步执行完再失败 = 前 2 步的副作用
 *   已经发生（文件已写、消息已发）却得到一个失败技——浪费且难善后。
 *   预检把「声明错误」与「运行时失败」分开：前者在零副作用时暴露。
 *
 * 决策④：AbortError 向上传播（不做 catch 转换）。
 *   与 Dispatcher 的约定一致：取消不是「工具失败」，不应被吞成
 *   step_failed 结果——取消语义要一路传到 Loop/命令层由它们决策。
 *   其余一切异常（resolveArgs 抛错）都被转换为 run_error 失败结果
 *   （「错误即数据」——执行器的边界必须兜底）。
 *
 * 决策⑤：步骤结果双通道（output 文本 + raw 完整 ToolResult）。
 *   见 types.ts 的 SkillStepOutcome 注释——需要结构化数据的步骤走 raw.meta。
 */

import { randomUUID } from 'node:crypto';
import type { EventBus } from '../kernel/events.ts';
import type { Dispatcher } from '../kernel/dispatcher.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { ToolCall } from '../types.ts';
import type { SkillRegistry } from './registry.ts';
import type { SkillResult, SkillStepOutcome } from './types.ts';

export interface SkillRunnerOptions {
  /** 技能声明来源 */
  readonly registry: SkillRegistry;
  /** 工具注册表（预检步骤声明的工具是否存在——不执行，只查询） */
  readonly tools: ToolRegistry;
  /** 工具执行权的唯一入口（技能与模型走同一条四步链） */
  readonly dispatcher: Dispatcher;
  readonly bus: EventBus;
  /** 时钟注入（durationMs 计算；默认 Date.now，测试注入可控时钟） */
  readonly now?: () => number;
}

/** 一次技能执行的运行参数（环境信息从调用方透传——执行器自身不持有环境） */
export interface SkillRunOptions {
  /** 事件关联：技能执行发生在哪个会话的上下文中 */
  readonly sessionId: string;
  /** 工具文件操作的沙箱根目录（转交 DispatchContext） */
  readonly workingDir: string;
  /** 技能级输入（步骤通过 ctx.input 读取；缺省为空对象） */
  readonly input?: Readonly<Record<string, unknown>>;
  /** 协作式取消信号（透传给 Dispatcher，取消时 AbortError 向上传播） */
  readonly signal?: AbortSignal | undefined;
}

export class SkillRunner {
  private readonly registry: SkillRegistry;
  private readonly tools: ToolRegistry;
  private readonly dispatcher: Dispatcher;
  private readonly bus: EventBus;
  private readonly now: () => number;

  constructor(options: SkillRunnerOptions) {
    this.registry = options.registry;
    this.tools = options.tools;
    this.dispatcher = options.dispatcher;
    this.bus = options.bus;
    this.now = options.now ?? Date.now;
  }

  /**
   * 执行一个技能。
   *
   * 返回值是结构化终态（成功/失败），**不抛异常**（AbortError 除外——
   * 见文件头决策④）。调用方（/skill 命令、代码直调）自行决定如何渲染。
   */
  async run(name: string, options: SkillRunOptions): Promise<SkillResult> {
    const started = this.now();

    // ---- ① 未知技能：零副作用，直接结构化失败 ----
    const skill = this.registry.get(name);
    if (skill === undefined) {
      const known = this.registry
        .list()
        .map((s) => s.name)
        .join(', ');
      return {
        ok: false,
        skill: name,
        reason: 'unknown_skill',
        message: `技能 "${name}" 未注册。${known === '' ? '当前技能库为空。' : `可用技能: ${known}`}`,
        steps: [],
        durationMs: this.now() - started,
      };
    }

    // ---- ② 整体预检：所有步骤引用的工具必须已注册（决策③）----
    for (const [index, step] of skill.steps.entries()) {
      if (!this.tools.has(step.tool)) {
        return {
          ok: false,
          skill: name,
          reason: 'unknown_tool',
          message: `技能 "${name}" 第 ${index + 1} 步引用了未注册的工具 "${step.tool}"（技能声明错误——修正注册后再执行）`,
          steps: [],
          durationMs: this.now() - started,
        };
      }
    }

    // ---- ③ 进入执行：事件边界 skill_started / skill_finished ----
    this.bus.emit({ type: 'skill_started', skill: name });
    const input = options.input ?? {};
    // queryId：技能自己的执行链标识（事件归组用；与 session 的 q_ 前缀区分）
    const queryId = `sk_${randomUUID()}`;

    const outcomes: SkillStepOutcome[] = [];
    let failure: { reason: 'step_failed' | 'run_error'; message: string; failedAt: number } | undefined;

    for (const [index, step] of skill.steps.entries()) {
      // ---- ④ 参数解析（唯一的本地异常源，转换为 run_error）----
      let args: Record<string, unknown>;
      try {
        // 快照传递（决策：防御步骤实现篡改共享数组，见 types.ts 注释）
        args = step.resolveArgs({ input, results: [...outcomes] });
      } catch (raw) {
        const message = raw instanceof Error ? raw.message : String(raw);
        failure = {
          reason: 'run_error',
          message: `第 ${index + 1} 步（${step.tool}）参数解析异常: ${message}`,
          failedAt: index,
        };
        break;
      }

      // ---- ⑤ 构造规范形 ToolCall（与模型产生的调用同构）----
      // id 唯一性范围：本次 run 内（技能不进会话消息链，无跨 run 关联需求）
      const call: ToolCall = {
        id: `skill:${name}:${index}`,
        name: step.tool,
        args,
        argsRaw: JSON.stringify(args),
      };

      // ---- ⑥ 走完整四步链（决策①——技能不绕过 Dispatcher）----
      // 注意：AbortError 会从 dispatch 抛出并穿透本执行器（决策④）
      const result = await this.dispatcher.dispatch(call, {
        sessionId: options.sessionId,
        queryId,
        workingDir: options.workingDir,
        signal: options.signal ?? new AbortController().signal,
      });

      outcomes.push({
        tool: step.tool,
        ok: result.ok,
        output: result.content,
        raw: result,
      });

      // ---- ⑦ fail-fast（决策②）----
      if (!result.ok) {
        failure = {
          reason: 'step_failed',
          message: `第 ${index + 1} 步（${step.tool}）失败: ${result.content}`,
          failedAt: index,
        };
        break;
      }
    }

    const durationMs = this.now() - started;
    if (failure !== undefined) {
      this.bus.emit({ type: 'skill_finished', skill: name, ok: false, durationMs });
      return {
        ok: false,
        skill: name,
        reason: failure.reason,
        message: failure.message,
        steps: outcomes,
        failedAt: failure.failedAt,
        durationMs,
      };
    }

    this.bus.emit({ type: 'skill_finished', skill: name, ok: true, durationMs });
    return { ok: true, skill: name, steps: outcomes, durationMs };
  }
}
