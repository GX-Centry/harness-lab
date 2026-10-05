/**
 * Eval Runner —— 场景 → rig → 证据 → 断言 → 报告。
 *
 * 契约（对齐 types.ts 哲学 ②：失败收集，不 fail-fast）：
 *   - 一个场景的**全部**断言都会执行——即使前面的失败，也继续跑完，
 *     一次给出完整失败清单；
 *   - 断言自身抛错（评测基建 bug）被捕获并记为失败——不炸整个批次；
 *   - run 本身抛错（理论上 Loop 会收敛，不应发生）同样被收敛为
 *     场景失败——评测的职责是「报告事实」，不是「成为新的崩溃源」。
 *
 * 为什么 runScenarios 是串行的？
 *   确定性优先：并发跑多个场景会让事件顺序、时钟、共享资源的交错
 *   变得不可预测；场景级并发留给将来「沙箱隔离 + 显式并发度」的版本。
 *   （当前 12 个场景合计仍低于可感知阈值——串行的性能代价可忽略。）
 *
 * 依赖方向：eval/runner.ts → eval/rig.ts + eval/session-rig.ts（双 rig 分派）
 * + types.ts（断言在场景里，runner 不认识具体断言）。报告渲染与 CI 退出码
 * 换算（reportExitCode）在此同文件——「格式 / 契约与数据同居一处」。
 */

import { createCoreRig } from './rig.ts';
import type { CoreRigOptions } from './rig.ts';
import { createSessionRig } from './session-rig.ts';
import type { EvalReport, EvalScenario, ScenarioEvidence, ScenarioResult } from './types.ts';

// ===========================================================================
// §1 单场景运行
// ===========================================================================

/**
 * 运行一个场景：装配 rig → 跑一次 → 逐条断言 → 收集结果 → 释放 rig。
 * 无论成败，rig 必被 close（finally）——订阅泄漏在长会话测试里会累积。
 */
export async function runScenario(
  scenario: EvalScenario,
  options: CoreRigOptions = {},
): Promise<ScenarioResult> {
  // 双 rig 分派（谱系见 rig.ts）：声明了会话预置 → Session Rig（含 Session/
  // SQLite 的完整装配）；否则 → Core Rig（纯内存内核）。数据驱动——场景
  // 不需要知道 rig 的存在（「场景即数据」哲学的一致性）。
  const rig =
    scenario.session !== undefined ? createSessionRig(scenario, options) : createCoreRig(scenario, options);
  try {
    let evidence: ScenarioEvidence;
    try {
      evidence = await rig.run(scenario.input);
    } catch (raw) {
      // Loop 契约上不抛（取消也收敛为 aborted 终态）——走到这里说明
      // 装配有问题（如剧本耗尽后 provider_error 穿出了不该穿的层）。
      const message = raw instanceof Error ? raw.message : String(raw);
      return failureResult(scenario, [`[run] 场景执行抛错（评测基建问题）: ${message}`]);
    }

    const failures: string[] = [];
    for (const assertion of scenario.assertions) {
      let failure: string | undefined;
      try {
        failure = assertion.check(evidence);
      } catch (raw) {
        // 断言自身抛错 = 评测代码 bug：记为失败而非崩溃（不掩错、不扩大伤害）
        failure = `断言自身抛错（评测代码 bug）: ${raw instanceof Error ? raw.message : String(raw)}`;
      }
      if (failure !== undefined) {
        failures.push(`[${assertion.name}] ${failure}`);
      }
    }

    return {
      name: scenario.name,
      description: scenario.description,
      ok: failures.length === 0,
      failures,
      summary: {
        stopReason: evidence.result?.stopReason,
        turns: evidence.result?.turns,
        toolCalls: evidence.loopEvents
          .filter((event) => event.type === 'tool_started')
          .map((event) => event.name),
      },
    };
  } finally {
    rig.close();
  }
}

// ===========================================================================
// §2 批量运行与报告
// ===========================================================================

/** 串行运行全部场景（顺序即输入顺序——报告可复现） */
export async function runScenarios(
  scenarios: readonly EvalScenario[],
  options: CoreRigOptions = {},
): Promise<EvalReport> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    results.push(await runScenario(scenario, options));
  }
  const passed = results.filter((result) => result.ok).length;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    durationMs: now() - startedAt,
    results,
  };
}

/**
 * CI 退出码语义锚定：有失败场景 → 1（红），全部通过 → 0（绿）。
 * 这是「报告 → 进程契约」的唯一换算点——入口脚本只做
 * `process.exitCode = reportExitCode(report)`；将来若要细分失败类别
 * （如 2 = 基础设施错误）也只改这里，调用方全部不动。
 */
export function reportExitCode(report: EvalReport): number {
  return report.failed > 0 ? 1 : 0;
}

// ===========================================================================
// §3 报告渲染（人读格式——数据在 EvalReport，格式只此一处）
// ===========================================================================

/** 渲染为多行文本（lab/CLI 直接 console.log；CI 退出码走 reportExitCode） */
export function renderEvalReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(
    `评测报告：${report.passed}/${report.total} 通过（${report.durationMs}ms）——断言「行为」而非文本`,
  );
  for (const result of report.results) {
    if (result.ok) {
      const s = result.summary;
      lines.push(
        `  ✓ ${result.name} — ${s.stopReason ?? '?'}，${s.turns ?? '?'} 轮，工具 [${s.toolCalls.join(', ') || '无'}]`,
      );
    } else {
      lines.push(`  ✗ ${result.name} — ${result.failures.length} 项失败`);
      for (const failure of result.failures) {
        lines.push(`      · ${failure}`);
      }
    }
  }
  return lines.join('\n');
}

// ===========================================================================
// §4 内部辅助
// ===========================================================================

/** 场景级失败的统一构造（run 抛错路径；摘要取空值——没有证据可总结） */
function failureResult(scenario: EvalScenario, failures: readonly string[]): ScenarioResult {
  return {
    name: scenario.name,
    description: scenario.description,
    ok: false,
    failures,
    summary: { stopReason: undefined, turns: undefined, toolCalls: [] },
  };
}
