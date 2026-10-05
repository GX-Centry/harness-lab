/**
 * 行为断言集 —— 十个「从证据到判定」的构造器。
 *
 * 设计约定（与 types.ts 的哲学 ①②呼应）：
 *   - 每个断言 = 一个构造器函数，返回 { name, check }——name 进报告，
 *     check 在拿到证据后返回 undefined（过）或失败原因（人读一句话）。
 *   - 失败原因必须**自足**：包含期望值 + 实际值 + 关键上下文——
 *     读报告的人不需要去翻日志拼线索。
 *   - 只断言「契约级行为」：终止原因 / 工具序列 / 错误码 / 子代理运行 /
 *     事件发射 / hook 判决 / 上下文注入物 / 会话状态 / 成本上限——刻意
 *     不提供任何「匹配模型回复文本」的 helper（上下文断言只针对 Harness
 *     自己组装的契约文本，边界见 §4 头注）。
 *
 * 与场景集的对照（builtin-scenarios.ts 用满前六个；w18 的场景集 scenarios/
 * 追加使用后四个）：
 *   assertStopReason       ← 每个场景的底线断言
 *   assertToolSequence     ← S1/S3：主世界到底调了哪些工具、什么顺序
 *   assertToolErrorCode    ← S2：权限拒绝必须变成 permission_denied 结果
 *   assertSubagentRan      ← S3：子代理真的跑过（且成功）；w18 扩展 ok:false 断言失败结算
 *   assertEventEmitted     ← S4：压缩链真的触发过
 *   assertCostUnder        ← S3：成本可查询、可上界（账本闭环）
 *   assertHookOutcome      ← w18 hook 场景：管道判决行为化（modify_input / block / modify_result）
 *   assertContextContains  ← w18 会话场景：补位占位符等 Harness 契约文本进入模型上下文
 *   assertSessionState     ← w18 会话场景：状态机终态（completed / interrupted）
 *   assertResumeFilled     ← w18 会话场景：恢复补位的精确数量
 *
 * 依赖方向：eval/assertions.ts → eval/types.ts + 全局类型。零运行时依赖。
 */

import type { ToolErrorCode } from '../errors.ts';
import type { EventName, HarnessEvent } from '../kernel/events.ts';
import type { HookOutcomeKind, LoopStopReason, Message, SessionState } from '../types.ts';
import type { EvalAssertion } from './types.ts';

// ===========================================================================
// §1 终止与流程
// ===========================================================================

/** 主循环以指定原因终止（completed / max_turns / budget / aborted） */
export function assertStopReason(expected: LoopStopReason): EvalAssertion {
  return {
    name: `终止原因 = ${expected}`,
    check: (evidence) => {
      const actual = evidence.result?.stopReason;
      if (actual === expected) return undefined;
      return `期望 stopReason=${expected}，实际=${actual ?? '（无终态——run 未产出 completed 信封）'}`;
    },
  };
}

/**
 * 主世界工具调用序列（按发生顺序；取自 LoopEvent——子世界事件不在其中，
 * 这正是隔离层的证据：子世界的工具活动不会"泄漏"进父世界的 UI 流）。
 * 语义注意：LoopEvent 的 tool_started 在「模型发起调用」时发出（**尝试面**）
 * ——被 block / 权限拒绝的调用同样计入。要断言「真正进入执行」的序列，
 * 请数 evidence.events 里 HarnessEvent 面的 tool_started（执行面；
 * 两面语义对照见场景 hook-block-repeat）。
 */
export function assertToolSequence(expected: readonly string[]): EvalAssertion {
  return {
    name: `主世界工具序列 = [${expected.join(' → ')}]`,
    check: (evidence) => {
      const actual = evidence.loopEvents
        .filter((event) => event.type === 'tool_started')
        .map((event) => event.name);
      const same =
        actual.length === expected.length && actual.every((name, i) => name === expected[i]);
      if (same) return undefined;
      return `期望 [${expected.join(', ')}]，实际 [${actual.join(', ') || '（空）'}]`;
    },
  };
}

// ===========================================================================
// §2 错误面
// ===========================================================================

/**
 * 指定工具曾经以指定错误码失败（任意世界——含子世界）。
 * 典型用法：权限拒绝场景断言 `permission_denied` 结果真实生成
 * （ADR-005：拒绝是「对话的一部分」，必须可被模型读到）。
 */
export function assertToolErrorCode(options: {
  readonly tool: string;
  readonly code: ToolErrorCode;
}): EvalAssertion {
  const { tool, code } = options;
  return {
    name: `工具 ${tool} 出现 ${code} 失败`,
    check: (evidence) => {
      const hit = evidence.events.some(
        (event) =>
          event.type === 'tool_finished' &&
          event.name === tool &&
          !event.ok &&
          event.errorCode === code,
      );
      if (hit) return undefined;
      // 自足失败原因：把该工具实际发生过什么列出来（期望 vs 实际）
      // 注：filter 需要显式类型谓词——否则回调内的收窄不会带到结果数组上
      const observed = evidence.events
        .filter(
          (event): event is Extract<HarnessEvent, { type: 'tool_finished' }> =>
            event.type === 'tool_finished' && event.name === tool,
        )
        .map((event) => (event.ok ? 'ok' : (event.errorCode ?? 'unknown')));
      return `未找到 ${tool} 的 ${code} 失败记录（该工具实际结果：${observed.join(', ') || '无调用'}）`;
    },
  };
}

// ===========================================================================
// §3 子代理与事件面
// ===========================================================================

/**
 * 子代理运行至少 min 次（缺省 1 次）。
 * ok 缺省 true = 「派出去并且跑成了」的底线断言；显式传 false = 断言
 * **失败结算**（w18 的 subagent-partial-failure：局部失败必须如实落账，
 * 而不是被伪装成成功或全军覆没）。
 */
export function assertSubagentRan(
  agent: string,
  options: { readonly min?: number; readonly ok?: boolean } = {},
): EvalAssertion {
  const min = options.min ?? 1;
  const ok = options.ok ?? true;
  const verdict = ok ? '成功' : '失败';
  return {
    name: `子代理 ${agent} ${verdict}运行 ≥ ${min} 次`,
    check: (evidence) => {
      const count = evidence.events.filter(
        (event) => event.type === 'subagent_finished' && event.subagent === agent && event.ok === ok,
      ).length;
      if (count >= min) return undefined;
      // 自足失败原因：列出该代理实际的全部运行结局（期望 vs 实际）
      const observed = evidence.events
        .filter(
          (event): event is Extract<HarnessEvent, { type: 'subagent_finished' }> =>
            event.type === 'subagent_finished' && event.subagent === agent,
        )
        .map((event) => (event.ok ? 'ok' : 'failed'));
      return `期望 ≥${min} 次${verdict}运行，实际 ${count} 次（该代理结局序列：[${observed.join(', ')}]）`;
    },
  };
}

/** 事件流中出现过指定类型的事件（压缩 / 记忆 / 命令……任何「某机制发动了」的证明） */
export function assertEventEmitted(type: EventName): EvalAssertion {
  return {
    name: `产生事件 ${type}`,
    check: (evidence) => {
      if (evidence.events.some((event) => event.type === type)) return undefined;
      const types = [...new Set(evidence.events.map((event) => event.type))].join(', ');
      return `事件流中未找到 ${type}（实际出现的类型：${types || '（无事件）'}）`;
    },
  };
}

/**
 * 指定 hook 产生过指定判决（kind 缺省 = 任意**实质**结局，即非 continue）。
 * 动机：把 hook 的效果「行为化」——不匹配日志文本，而是断言管道真的把
 * 某条 hook 的判决上报成了 hook_outcome 事件（判决即数据）。
 * 典型用法：repeat-guard 熔断 → kind:'block'；自定义改写 hook →
 * kind:'modify_input' / 'modify_result'。
 */
export function assertHookOutcome(options: {
  readonly hook: string;
  readonly kind?: HookOutcomeKind;
}): EvalAssertion {
  const { hook, kind } = options;
  const expectedText = kind ?? '实质结局（非 continue）';
  return {
    name: `hook ${hook} 产生 ${expectedText}`,
    check: (evidence) => {
      const hit = evidence.events.some(
        (event) =>
          event.type === 'hook_outcome' &&
          event.hookName === hook &&
          (kind === undefined ? event.kind !== 'continue' : event.kind === kind),
      );
      if (hit) return undefined;
      // 自足失败原因：列出该 hook 实际的判决序列
      const observed = evidence.events
        .filter(
          (event): event is Extract<HarnessEvent, { type: 'hook_outcome' }> =>
            event.type === 'hook_outcome' && event.hookName === hook,
        )
        .map((event) => event.kind);
      return `未找到 ${hook} 的 ${expectedText}（该 hook 实际判决：[${observed.join(', ')}]）`;
    },
  };
}

// ===========================================================================
// §4 上下文面
// ===========================================================================

/**
 * 上下文断言：发给模型的请求中某条消息含指定片段（role 限定角色，缺省任意）。
 * 允许「文本包含」而不违背「断言行为而非文本」哲学——它断的不是模型回复的
 * 自由发挥，而是 Harness 自己组装的**契约文本**：恢复补位的占位说明、
 * hook 改写后的输入回显、注入的记忆画像等。这些文本是框架产物，属于契约。
 */
export function assertContextContains(options: {
  readonly text: string;
  readonly role?: Message['role'];
}): EvalAssertion {
  const { text, role } = options;
  const roleText = role === undefined ? '任意角色' : `role=${role}`;
  return {
    name: `上下文含 ${roleText} 消息「${preview(text)}」`,
    check: (evidence) => {
      const hit = evidence.requests.some((request) =>
        request.messages.some(
          (message) =>
            (role === undefined || message.role === role) && message.content.includes(text),
        ),
      );
      if (hit) return undefined;
      // 自足失败原因：实际消息去重预览（超出上限截断——报告可读性优先）
      const seen = new Set<string>();
      const lines: string[] = [];
      for (const request of evidence.requests) {
        for (const message of request.messages) {
          if (role !== undefined && message.role !== role) continue;
          const line = `${message.role}: ${preview(message.content, 40)}`;
          if (!seen.has(line)) {
            seen.add(line);
            lines.push(line);
          }
        }
      }
      const maxLines = 6;
      const shown = lines.slice(0, maxLines).join('；');
      const more = lines.length > maxLines ? ` …（共 ${lines.length} 条）` : '';
      return `上下文未找到「${text}」（实际 ${roleText} 消息预览：${shown || '（无请求）'}${more}）`;
    },
  };
}

/** 单行预览：压缩空白、截断到 max 字符（失败原因可读性辅助——非契约） */
function preview(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

// ===========================================================================
// §5 会话面（仅 Session Rig 提供证据——见 eval/session-rig.ts）
// ===========================================================================

/**
 * 会话状态机终态断言（completed / interrupted / failed / processing）。
 * 证据缺失 = 场景未用 Session Rig（装配问题而非行为问题——失败原因说清楚）。
 */
export function assertSessionState(expected: SessionState): EvalAssertion {
  return {
    name: `会话终态 = ${expected}`,
    check: (evidence) => {
      const session = evidence.session;
      if (session === undefined) {
        return '场景未使用 Session Rig（无会话面证据——检查 scenario.session 是否声明）';
      }
      const actual = session.stateAfter;
      if (actual === expected) return undefined;
      return `期望 ${expected}，实际 ${actual ?? '（无状态记录）'}`;
    },
  };
}

/**
 * 恢复补位断言：resumeSession 恰好补了 count 个「中断工具调用」占位。
 * 精确值（不是下界）——补位数量就是恢复质量本身，多补 / 少补都是 bug。
 * 未触发恢复流程时失败原因明确区分（状态门控没走到 vs 场景选错 rig）。
 */
export function assertResumeFilled(count: number): EvalAssertion {
  return {
    name: `恢复补位工具结果 = ${count} 个`,
    check: (evidence) => {
      const session = evidence.session;
      if (session === undefined) {
        return '场景未使用 Session Rig（无会话面证据——检查 scenario.session 是否声明）';
      }
      const resume = session.resume;
      if (resume === undefined) {
        return '未触发恢复流程（resumeSession 未被调用——预置状态需为 interrupted / processing）';
      }
      const actual = resume.filledToolCallIds.length;
      if (actual === count) return undefined;
      return `期望补位 ${count} 个，实际 ${actual} 个（filledToolCallIds: [${resume.filledToolCallIds.join(', ')}]）`;
    },
  };
}

// ===========================================================================
// §6 成本面
// ===========================================================================

/**
 * 成本上界断言（美元）。scope 缺省 = 总账；可限定子代理或单次 query。
 * 这是「账本闭环」的证明：成本不是打印出来看看的数字，而是**可断言的契约**。
 */
export function assertCostUnder(
  limitUsd: number,
  scope: { readonly subagent?: string; readonly queryId?: string } = {},
): EvalAssertion {
  const scopeText =
    scope.subagent !== undefined
      ? `子代理 ${scope.subagent}`
      : scope.queryId !== undefined
        ? `query ${scope.queryId}`
        : '总账';
  return {
    name: `${scopeText} 成本 < $${limitUsd}`,
    check: (evidence) => {
      const cost = evidence.cost;
      if (cost === undefined) {
        return '未装配 CostTracker（场景需保持 config.observability.costTracking=true）';
      }
      const summary =
        scope.subagent !== undefined
          ? cost.bySubagent(scope.subagent)
          : scope.queryId !== undefined
            ? cost.byQuery(scope.queryId, { includeDerived: true })
            : cost.total();
      if (summary.calls === 0) {
        return `${scopeText}没有记账条目（断言失去意义——检查场景是否真的调用了模型）`;
      }
      if (summary.estimatedCostUsd < limitUsd) return undefined;
      return `${scopeText}成本 $${summary.estimatedCostUsd.toFixed(6)} 不低于上限 $${limitUsd}（${summary.calls} 次调用）`;
    },
  };
}

// ===========================================================================
// §7 组合工坊（保留区——刻意不实现，标注动机）
// ===========================================================================

/*
 * 预留的断言扩展方向（ADR-010 的「注释保留」原则，避免过度设计）：
 *
 * - assertTurnsAtMost(n)：轮次上界。当前用 summary.turns 在报告里「可见即够」；
 *   等出现第一个「轮次失控」的真实 bug 再升级为断言（P2）。
 * - assertEventOrder(a, b)：事件前后关系（如 tool_started 早于 llm_response）。
 *   Tracer 已按 seq 排序，实现是 5 行；暂缓的理由同上——没有场景在用。
 * - assertResumeNotTriggered()：「不该恢复」的负路径。当前 session 负路径
 *   场景用内联断言达成（session.resume === undefined）；第二个使用点出现再固化。
 *
 * 已毕业的保留项（保留区 → 正式 helper 的迁移记录）：
 * - assertContextContains ← w18 会话恢复场景需要断言补位占位符进入上下文，
 *   真实需求出现，已移入 §4 上下文面（缺省任意角色 + role 限定）。
 */
