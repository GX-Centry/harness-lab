/**
 * Dispatcher —— 单次工具调用的四步执行链（全项目最核心的管道）。
 *
 * 为什么所有工具调用必须收敛到这一个入口？
 *   横切关注点（hook / 权限 / 校验 / 超时 / 兜底 / 事件）只能在「唯一入口」处
 *   可靠地发生。任何绕过 Dispatcher 的直连执行都会产生「有的调用没脱敏、
 *   有的没审计、有的权限漏检」这类隐蔽缺口——本文件就是那个单点。
 *
 * 执行链全景（顺序即语义）：
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ 0. 组装事件 tool_call_assembled + 两条快速路径：               │
 *   │    a) parseError（流式截断的参数）→ input_error 结果           │
 *   │    b) 未知工具 → input_error 结果（附可用工具列表）             │
 *   ├──────────────────────────────────────────────────────────────┤
 *   │ 1. pre-hooks（tool_call_before）：脱敏/熔断/预检                │
 *   │    → blocked：不执行，生成拒绝结果                              │
 *   │    → modify_input：后续步骤与执行都使用新参数                   │
 *   ├──────────────────────────────────────────────────────────────┤
 *   │ 2. permission.check：allow / confirm / deny                    │
 *   │    → deny：生成 permission_denied 结果返回给模型（ADR-005）      │
 *   ├──────────────────────────────────────────────────────────────┤
 *   │ 3. zod 校验 → 失败生成 input_error 结果（模型可自我修正）        │
 *   │    execute（超时保护 + 兜底 catch；AbortError 穿透）             │
 *   ├──────────────────────────────────────────────────────────────┤
 *   │ 4. post-hooks（tool_call_after）：审计/结果脱敏/截断            │
 *   │    → modify_result 更新最终结果                                 │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * 三个贯穿性约定：
 *   - **本方法永不抛错**（除取消类 AbortError）——一切失败都变成 ToolResult
 *     （ADR-004）；AbortError 是控制流不是错误，必须穿透给 Loop 处理；
 *   - **权限拒绝不终止循环**：它是一条给模型的工具结果，模型可以换路（ADR-005）；
 *   - **事件配对契约**（w14 场景层暴露并修复的缺口）：tool_call_assembled 与
 *     tool_finished 是每次调用必配对的事件——快速失败路径（参数残缺/未知工具/
 *     被拦截/权限拒绝/校验失败）同样发布 tool_finished（errorCode 表达结局），
 *     审计与可观测层因此能完整重建「每一次调用的下场」。tool_started 仅标记
 *     「真正进入执行阶段」，被拒绝的调用没有它——这个不对称是有意设计。
 *     （hook_* 事件由 hooks 管道内部发布；本模块发布 assembled/started/finished。）
 *
 * 依赖方向：kernel/dispatcher.ts → tools/ / hooks/ / permission/ / types / errors / config。
 */

import type { HarnessConfig } from '../config.ts';
import { HarnessError, isAbortError, toHarnessError, toToolErrorCode } from '../errors.ts';
import type { HookPipeline } from '../hooks/pipeline.ts';
import type { PermissionGate } from '../permission/gate.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import { validateToolInput } from '../tools/validation.ts';
import type {
  AnyTool,
  HookContext,
  ToolCall,
  ToolContext,
  ToolResult,
} from '../types.ts';
import { failedResult } from '../types.ts';
import type { EventBus } from './events.ts';

// ===========================================================================
// §1 输入形状
// ===========================================================================

export interface DispatcherOptions {
  readonly registry: ToolRegistry;
  readonly hooks: HookPipeline;
  readonly permission: PermissionGate;
  readonly bus: EventBus;
  readonly config: HarnessConfig;
  /** 时钟注入（durationMs 计算；默认 Date.now，测试注入可控时钟） */
  readonly now?: () => number;
}

/** 每次 dispatch 的调用侧上下文（Loop 注入） */
export interface DispatchContext {
  readonly sessionId: string;
  readonly queryId: string;
  /** 工具的文件操作根目录（沙箱边界，来自会话配置而非进程 cwd） */
  readonly workingDir: string;
  /** 协作式取消信号（用户中断/全局超时向下传播） */
  readonly signal: AbortSignal;
}

// ===========================================================================
// §2 Dispatcher 实现
// ===========================================================================

export class Dispatcher {
  private readonly registry: ToolRegistry;
  private readonly hooks: HookPipeline;
  private readonly permission: PermissionGate;
  private readonly bus: EventBus;
  private readonly config: HarnessConfig;
  private readonly now: () => number;

  constructor(options: DispatcherOptions) {
    this.registry = options.registry;
    this.hooks = options.hooks;
    this.permission = options.permission;
    this.bus = options.bus;
    this.config = options.config;
    this.now = options.now ?? Date.now;
  }

  /**
   * 执行一个工具调用，返回最终工具结果。
   * 输出保证：一切失败（参数错/无权限/超时/工具内部异常）都是 ToolResult——
   * 调用方（Loop）不需要 try/catch，唯一需要处理的异常是 AbortError（取消）。
   *
   * 结构：dispatch（事件配对的外壳）→ runChain（执行链主体）。
   * assembled ↔ finished 恰好各发一次，无论结局来自哪条路径；AbortError
   * 穿透时不发 finished（取消是控制流不是结局——由 w08 Loop 收敛）。
   */
  async dispatch(call: ToolCall, ctx: DispatchContext): Promise<ToolResult> {
    this.bus.emit({
      type: 'tool_call_assembled',
      toolCallId: call.id,
      name: call.name,
      parseOk: call.parseError === undefined,
      sessionId: ctx.sessionId,
      queryId: ctx.queryId,
    });

    const startedAt = this.now();
    const result = await this.runChain(call, ctx);

    // 统一出口（配对契约的「结局」侧）：durationMs = 从「受理」到「结局」的
    // 总时长（含 hook/权限/执行/post-hook 的全部开销）——观测者视角的
    // 「这次调用花了多久」；被拒绝的调用同样有结局（errorCode 承载原因）。
    this.bus.emit({
      type: 'tool_finished',
      toolCallId: call.id,
      name: call.name,
      ok: result.ok,
      ...(result.ok ? {} : { errorCode: result.error.code }),
      durationMs: this.now() - startedAt,
      sessionId: ctx.sessionId,
      queryId: ctx.queryId,
    });
    return result;
  }

  /**
   * 调用链主体（不含事件外壳——配对事件由 dispatch 负责）：
   *   快速路径（参数残缺/未知工具）→ pre-hooks → 权限检查 → 参数校验
   *   → 执行（超时保护）→ post-hooks（结果替换/拦截）。
   * 一切失败都收敛为 ToolResult；AbortError 是控制流，穿透给 Loop。
   */
  private async runChain(call: ToolCall, ctx: DispatchContext): Promise<ToolResult> {
    // ---- 快速路径 a：参数 JSON 残缺（流式截断后组装器的降级产物）----
    if (call.parseError !== undefined) {
      return failedResult(
        'input_error',
        `工具参数 JSON 无效: ${call.parseError}`,
        `你为工具 "${call.name}" 生成的参数 JSON 无法解析（${call.parseError}）。` +
          '请重新生成完整、合法的 JSON 参数后重试。',
      );
    }

    // ---- 快速路径 b：未知工具（模型幻觉工具名是常态，需要引导而非崩溃）----
    const tool = this.registry.get(call.name);
    if (tool === undefined) {
      const available = this.registry
        .list()
        .map((t) => t.name)
        .join(', ');
      return failedResult(
        'input_error',
        `未知工具: ${call.name}`,
        `不存在名为 "${call.name}" 的工具。可用工具：${available}。请从列表中选择并重试。`,
      );
    }

    const hookCtx = this.buildHookContext(ctx);
    const toolInfo = { name: tool.name, risk: tool.risk };

    // ---- 步骤 1/4：pre-hooks ----
    const preOutcome = await this.hooks.run(
      {
        event: 'tool_call_before',
        sessionId: ctx.sessionId,
        queryId: ctx.queryId,
        toolCall: call,
        tool: toolInfo,
        input: call.args,
      },
      hookCtx,
    );
    if (preOutcome.blocked !== undefined) {
      return failedResult(
        'permission_denied',
        `调用被拦截: ${preOutcome.blocked.reason}`,
        `工具 "${call.name}" 的调用被框架拦截：${preOutcome.blocked.reason}`,
      );
    }
    const input = preOutcome.input; // 可能被 modify_input 更新（如参数脱敏）

    // ---- 步骤 2/4：权限检查 ----
    const permissionOutcome = await this.permission.check({
      sessionId: ctx.sessionId,
      queryId: ctx.queryId,
      toolName: call.name,
      risk: tool.risk,
      input,
    });
    this.bus.emit({
      type: 'permission_decision',
      toolName: call.name,
      risk: tool.risk,
      decision: permissionOutcome.decision,
      reason: permissionOutcome.reason,
      sessionId: ctx.sessionId,
      queryId: ctx.queryId,
    });
    if (permissionOutcome.decision === 'deny') {
      // ADR-005：拒绝是「对话的一部分」——注入模型上下文而非终止循环
      return failedResult(
        'permission_denied',
        `权限拒绝: ${permissionOutcome.reason}`,
        `工具 "${call.name}" 的调用被权限系统拒绝：${permissionOutcome.reason}。` +
          '请改用其他方式完成任务，或调整参数后重试。',
      );
    }

    // ---- 步骤 3/4：参数校验 + 执行 ----
    const validation = validateToolInput(tool, input);
    if (!validation.ok) {
      return failedResult(
        'input_error',
        validation.message,
        `工具 "${call.name}" 的参数不合法：${validation.message}\n请修正参数后重试。`,
      );
    }

    // 执行前最后一次取消检查：已取消就不启动（省掉无意义的执行）
    if (ctx.signal.aborted) {
      throw new DOMException(`工具 "${call.name}" 在执行前已被取消`, 'AbortError');
    }

    this.bus.emit({
      type: 'tool_started',
      toolCallId: call.id,
      name: call.name,
      sessionId: ctx.sessionId,
      queryId: ctx.queryId,
    });

    let result: ToolResult;
    try {
      result = await this.executeWithTimeout(tool, validation.input, {
        sessionId: ctx.sessionId,
        queryId: ctx.queryId,
        workingDir: ctx.workingDir,
        signal: ctx.signal,
        // 超时解析顺序：工具自声明 > 全局默认（w13）。子代理工具内部有
        // 协作式超时（taskTimeoutMs），申报的外层预算 = 内部超时 + 缓冲——
        // 外层必须晚于内层触发，否则子循环被 Promise.race 丢下成为僵尸。
        timeoutMs: tool.timeoutMs ?? this.config.tools.defaultTimeoutMs,
      });
    } catch (raw) {
      // 取消是控制流：穿透给 Loop（它决定是中断会话还是继续）
      if (isAbortError(raw)) throw raw;
      // 兜底：工具违反「永不抛」协议时，Dispatcher 是最后防线
      const error = toHarnessError(raw, 'kernel/dispatcher');
      result =
        error.code === 'timeout_error'
          ? failedResult('timeout', error.message, `工具 "${call.name}" 执行超时，可以尝试重试或缩小输入范围。`)
          : failedResult(toToolErrorCode(error.code), error.message);
    }

    // ---- 步骤 4/4：post-hooks ----
    const postOutcome = await this.hooks.run(
      {
        event: 'tool_call_after',
        sessionId: ctx.sessionId,
        queryId: ctx.queryId,
        toolCall: call,
        tool: toolInfo,
        input, // 执行时的最终参数（audit 记录用）
        result,
      },
      hookCtx,
    );
    if (postOutcome.blocked !== undefined) {
      // post 阶段 block 的语义：结果被判定不可接受 → 替换为拒绝结果
      // （更常见的结果替换应使用 modify_result；block 留给「必须否决」的场景）
      return failedResult('permission_denied', `结果被拦截: ${postOutcome.blocked.reason}`);
    }
    if (postOutcome.result !== undefined) {
      result = postOutcome.result; // 可能被 modify_result 加工（脱敏/截断）
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // 内部实现
  // -------------------------------------------------------------------------

  /** 构造 hook 运行环境：now 注入 + log 桥接到事件流（统一可观测出口） */
  private buildHookContext(ctx: DispatchContext): HookContext {
    return {
      sessionId: ctx.sessionId,
      queryId: ctx.queryId,
      now: this.now,
      log: (message) => {
        this.bus.emit({
          type: 'log',
          level: 'info',
          message,
          sessionId: ctx.sessionId,
          queryId: ctx.queryId,
        });
      },
    };
  }

  /**
   * 带超时保护执行工具。
   *
   * 语义注解（重要）：
   *   - Promise.race 的「超时」是**保护**不是**取消**——超时后工具若无视
   *     signal 仍在后台跑（僵尸 promise）。真正的取消需要工具尊重 ctx.signal；
   *   - 超时定时器必须在 finally 清理，否则少量超时场景就会积累悬挂 timer。
   */
  private async executeWithTimeout(tool: AnyTool, input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const timeoutMs = ctx.timeoutMs ?? this.config.tools.defaultTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new HarnessError('timeout_error', `工具 "${tool.name}" 执行超时 (${timeoutMs}ms)`, {
            where: 'kernel/dispatcher',
          }),
        );
      }, timeoutMs);
    });
    try {
      return await Promise.race([tool.execute(input, ctx), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
