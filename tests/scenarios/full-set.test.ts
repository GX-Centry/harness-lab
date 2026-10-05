/**
 * 完整场景集集成测试（scenarios/ 层——三层测试策略的顶层形态）。
 *
 * 锚定的行为：
 *   - 全量 12 场景端到端全过（内置基准 4 + 权限/hook/子代理/会话 8）——
 *     含 Session Rig 的跨进程恢复路径（临时 SQLite 真库真连接）；
 *   - 聚合形态守护：场景名唯一（Session Rig 的库路径由名字派生，重名会
 *     互相覆盖——这是真实的隔离隐患，不是形式检查）、各域数量结构；
 *   - CI 契约：reportExitCode 的 0/1 语义（报告 → 进程退出码的唯一换算点）。
 *
 * 与 tests/integration/eval.test.ts 的分工：
 *   那边的对象是「eval 机制」（失败收集/开关联动/报告渲染）；
 *   本文件的对象是「场景集内容」（12 个场景的端到端行为锚定）。
 */

import { describe, expect, it } from 'vitest';
import { renderEvalReport, reportExitCode, runScenarios } from '../../src/eval/index.ts';
import type { EvalReport } from '../../src/eval/index.ts';
import {
  createFullScenarioSet,
  createHookScenarios,
  createPermissionScenarios,
  createSessionScenarios,
  createSubagentScenarios,
} from '../../scenarios/index.ts';

// ===========================================================================
// §1 全量端到端
// ===========================================================================

describe('完整场景集', () => {
  it('12 个场景全部通过（失败时输出人读报告便于定位）', async () => {
    const report = await runScenarios(createFullScenarioSet());
    // 第二参数 = 失败时打印的说明（人读报告全文——CI 日志自解释）
    expect(report.failed, renderEvalReport(report)).toBe(0);
    expect(report.total).toBe(12);
    expect(report.passed).toBe(12);
  });

  it('reportExitCode：全部通过 → 0（CI 绿）', async () => {
    const report = await runScenarios(createFullScenarioSet());
    expect(reportExitCode(report)).toBe(0);
  });

  // =========================================================================
  // §2 聚合形态守护
  // =========================================================================

  it('场景名唯一（Session Rig 的库路径由名字派生——重名会互相覆盖）', () => {
    const names = createFullScenarioSet().map((scenario) => scenario.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('域数量结构：内置 4 + 权限 1 + hook 3 + 子代理 2 + 会话 2 = 12', () => {
    expect(createPermissionScenarios()).toHaveLength(1);
    expect(createHookScenarios()).toHaveLength(3);
    expect(createSubagentScenarios()).toHaveLength(2);
    expect(createSessionScenarios()).toHaveLength(2);
    expect(createFullScenarioSet()).toHaveLength(12);
  });

  // =========================================================================
  // §3 CI 契约（reportExitCode 的换算语义——单元锚定，不跑场景）
  // =========================================================================

  it('reportExitCode：failed > 0 → 1（CI 红）', () => {
    const failing: EvalReport = { total: 1, passed: 0, failed: 1, durationMs: 1, results: [] };
    expect(reportExitCode(failing)).toBe(1);
    const passing: EvalReport = { total: 1, passed: 1, failed: 0, durationMs: 1, results: [] };
    expect(reportExitCode(passing)).toBe(0);
  });
});
