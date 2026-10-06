/**
 * 权限模式（manual / semi / auto）单元测试 —— 「全自动 / 半自动」的行为契约。
 *
 * 背景（w18）：接入真实 API 后暴露的体验断点——所有演示必须每步人工批准。
 * 修复 = 三档运行姿态 + 运行期切换。本文件锁定其全部承诺：
 *
 * 覆盖矩阵：
 *   ① 解析与描述：parsePermissionMode 宽容写法；describePermissionMode 三档文案；
 *   ② 控制器：可变单一真源——门禁持引用，setMode 即时生效（无需重建装配）；
 *   ③ 三档语义（gate 集成）：
 *        manual → confirm 一律询问（回归锚点：与历史行为一致）；
 *        semi   → low/medium 自动放行（source='mode'）；high/critical 仍询问；
 *        auto   → 全部 confirm 自动批准（source='mode'；reason 如实标注「未询问用户」）；
 *   ④ 三个不变量（三档都不改变——「保留安全边界」的底线）：
 *        ① 规则 deny 仍拒绝（模式只影响 confirm 层）；
 *        ② 规则 allow 不受影响（本来就无需确认）；
 *        ③ fail-safe 缺省不变：manual/semi 下无确认通道仍拒绝；
 *          auto 是用户显式声明——不依赖确认通道（不是「通道缺失」的兜底）。
 */

import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/config.ts';
import type { PermissionConfig } from '../../src/config.ts';
import { PermissionGate } from '../../src/permission/gate.ts';
import type { PermissionRequest } from '../../src/permission/gate.ts';
import {
  createPermissionModeController,
  describePermissionMode,
  parsePermissionMode,
  PERMISSION_MODES,
} from '../../src/permission/modes.ts';
import type { PermissionRule } from '../../src/permission/rules.ts';
import type { PermissionMode, RiskLevel } from '../../src/types.ts';

// ---------------------------------------------------------------------------
// 测试装置
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<PermissionConfig> = {}): PermissionConfig {
  return { ...defaultConfig.permission, ...overrides };
}

function makeRequest(toolName: string, risk: RiskLevel): PermissionRequest {
  return { sessionId: 's1', queryId: 'q1', toolName, risk, input: {} };
}

/** 记录 confirm 是否被调用的直通 handler */
function trackingConfirm(allow: boolean): { confirm: () => Promise<boolean>; wasCalled: () => boolean } {
  let called = false;
  return {
    confirm: async () => {
      called = true;
      return allow;
    },
    wasCalled: () => called,
  };
}

// ---------------------------------------------------------------------------
// ① 解析与描述
// ---------------------------------------------------------------------------

describe('parsePermissionMode / describePermissionMode', () => {
  it('三档合法值按展示顺序注册（manual → semi → auto）', () => {
    expect([...PERMISSION_MODES]).toEqual(['manual', 'semi', 'auto']);
  });

  it('解析宽容：大小写与首尾空白（环境变量的书写习惯不可预测）', () => {
    expect(parsePermissionMode('auto')).toBe('auto');
    expect(parsePermissionMode('SEMI')).toBe('semi');
    expect(parsePermissionMode('  Manual  ')).toBe('manual');
    expect(parsePermissionMode(' Semi ')).toBe('semi');
  });

  it('未知值返回 undefined（由调用方决定报错 / 回退）', () => {
    expect(parsePermissionMode('turbo')).toBeUndefined();
    expect(parsePermissionMode('')).toBeUndefined();
    expect(parsePermissionMode('automatic')).toBeUndefined();
  });

  it('三档描述各含关键语义（同一事实同一表述——横幅/命令/Web 共用）', () => {
    expect(describePermissionMode('manual')).toContain('询问用户');
    expect(describePermissionMode('semi')).toContain('low/medium');
    expect(describePermissionMode('semi')).toContain('high/critical');
    expect(describePermissionMode('auto')).toContain('自动批准');
    expect(describePermissionMode('auto')).toContain('deny');
  });
});

// ---------------------------------------------------------------------------
// ② 控制器：可变单一真源
// ---------------------------------------------------------------------------

describe('PermissionModeController', () => {
  it('初始值来自构造参数；setMode 后 mode 立即变化', () => {
    const controller = createPermissionModeController('manual');
    expect(controller.mode).toBe('manual');
    controller.setMode('auto');
    expect(controller.mode).toBe('auto');
  });

  it('门禁持引用：setMode 无需重建 gate，后续每次 check 读到最新模式', async () => {
    const controller = createPermissionModeController('manual');
    const confirm = trackingConfirm(true);
    const gate = new PermissionGate({
      config: makeConfig(),
      confirm: confirm.confirm,
      mode: controller,
    });

    // manual：high 走确认（handler 被调用）
    const first = await gate.check(makeRequest('fs-write', 'high'));
    expect(first.source).toBe('confirm');
    expect(confirm.wasCalled()).toBe(true);

    // 运行期切换 → 同一条 gate 的下一次 check 直接自动批准
    controller.setMode('auto');
    const second = await gate.check(makeRequest('fs-write', 'high'));
    expect(second.decision).toBe('allow');
    expect(second.source).toBe('mode');
  });
});

// ---------------------------------------------------------------------------
// ③ 三档语义（gate 集成；基础 fixture：无规则——策略表生效）
// ---------------------------------------------------------------------------

describe('gate × manual（回归锚点：与历史行为一致）', () => {
  it('medium（策略 confirm）→ 走确认交互', async () => {
    const confirm = trackingConfirm(true);
    const gate = new PermissionGate({
      config: makeConfig(),
      confirm: confirm.confirm,
      mode: createPermissionModeController('manual'),
    });
    const outcome = await gate.check(makeRequest('fs-read', 'medium'));
    expect(outcome.decision).toBe('allow');
    expect(outcome.source).toBe('confirm');
    expect(confirm.wasCalled()).toBe(true);
  });
});

describe('gate × semi（low/medium 自动；high/critical 仍询问）', () => {
  const semiGate = (confirmAllow: boolean): {
    gate: PermissionGate;
    wasCalled: () => boolean;
  } => {
    const confirm = trackingConfirm(confirmAllow);
    const gate = new PermissionGate({
      config: makeConfig(),
      confirm: confirm.confirm,
      mode: createPermissionModeController('semi'),
    });
    return { gate, wasCalled: confirm.wasCalled };
  };

  it('low（策略已 allow）不受模式影响：source=risk_policy、不询问', async () => {
    const { gate, wasCalled } = semiGate(true);
    const outcome = await gate.check(makeRequest('echo', 'low'));
    expect(outcome.decision).toBe('allow');
    expect(outcome.source).toBe('risk_policy');
    expect(wasCalled()).toBe(false);
  });

  it('medium（策略 confirm）→ 自动放行：source=mode、reason 如实标注「未询问用户」', async () => {
    const { gate, wasCalled } = semiGate(true);
    const outcome = await gate.check(makeRequest('fs-read', 'medium'));
    expect(outcome.decision).toBe('allow');
    expect(outcome.source).toBe('mode');
    expect(outcome.reason).toContain('semi');
    expect(outcome.reason).toContain('自动批准');
    expect(outcome.reason).toContain('未询问用户');
    expect(wasCalled()).toBe(false); // 模式内短路——确认通道未被惊动
  });

  it('high → 仍走确认交互（半自动的边界）', async () => {
    const { gate, wasCalled } = semiGate(true);
    const outcome = await gate.check(makeRequest('fs-write', 'high'));
    expect(outcome.decision).toBe('allow');
    expect(outcome.source).toBe('confirm');
    expect(wasCalled()).toBe(true);
  });

  it('critical → 仍走确认交互；用户拒绝 → deny', async () => {
    const { gate, wasCalled } = semiGate(false);
    const outcome = await gate.check(makeRequest('shell', 'critical'));
    expect(outcome.decision).toBe('deny');
    expect(outcome.source).toBe('confirm');
    expect(wasCalled()).toBe(true);
  });
});

describe('gate × auto（确认决策自动批准）', () => {
  it('high → 自动批准：source=mode、不经过确认通道', async () => {
    const confirm = trackingConfirm(true);
    const gate = new PermissionGate({
      config: makeConfig(),
      confirm: confirm.confirm,
      mode: createPermissionModeController('auto'),
    });
    const outcome = await gate.check(makeRequest('fs-write', 'high'));
    expect(outcome.decision).toBe('allow');
    expect(outcome.source).toBe('mode');
    expect(outcome.reason).toContain('auto');
    expect(confirm.wasCalled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ④ 三个不变量
// ---------------------------------------------------------------------------

describe('三档不变量（模式不越权）', () => {
  it('不变量①：规则 deny 在 auto 下仍然拒绝（模式只影响 confirm 层）', async () => {
    const rules: PermissionRule[] = [{ match: 'echo', decision: 'deny', reason: '演示：手动封禁' }];
    const gate = new PermissionGate({
      config: makeConfig(),
      rules,
      mode: createPermissionModeController('auto'),
    });
    const outcome = await gate.check(makeRequest('echo', 'low'));
    expect(outcome.decision).toBe('deny');
    expect(outcome.source).toBe('rule');
    expect(outcome.reason).toBe('演示：手动封禁');
  });

  it('不变量②：规则 allow 不受模式影响（本来就无需确认）', async () => {
    const rules: PermissionRule[] = [{ match: 'fs-read', decision: 'allow', reason: '白名单目录' }];
    const gate = new PermissionGate({
      config: makeConfig(),
      rules,
      mode: createPermissionModeController('manual'),
    });
    const outcome = await gate.check(makeRequest('fs-read', 'medium'));
    expect(outcome.decision).toBe('allow');
    expect(outcome.source).toBe('rule');
  });

  it('不变量③：manual/semi 下无确认通道仍拒绝（fail-safe 缺省不变）', async () => {
    const manualAndSemi: readonly PermissionMode[] = ['manual', 'semi'];
    for (const mode of manualAndSemi) {
      const gate = new PermissionGate({
        config: makeConfig(),
        mode: createPermissionModeController(mode), // 不传 confirm
      });
      const outcome = await gate.check(makeRequest('fs-write', 'high'));
      expect(outcome.decision).toBe('deny');
      expect(outcome.reason).toContain('无确认通道');
    }
  });

  it('不变量③（边界）：auto 是显式无人值守声明——不依赖确认通道', async () => {
    const gate = new PermissionGate({
      config: makeConfig(),
      mode: createPermissionModeController('auto'), // 不传 confirm
    });
    const outcome = await gate.check(makeRequest('fs-write', 'high'));
    expect(outcome.decision).toBe('allow');
    expect(outcome.source).toBe('mode');
  });
});
