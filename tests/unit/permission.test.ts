/**
 * PermissionGate 与权限规则单元测试。
 * 锚定的决策：
 *   - 决策优先级：规则匹配 > 风险级默认策略（显式声明优先于推导）；
 *   - confirm 四结局（allow/deny/timeout/unavailable）在 reason 上可区分；
 *   - fail-safe 内核：无交互通道 → 拒绝；handler 异常 → check 永不抛，收敛为 deny；
 *   - findRule：精确名 > '*' 通配，同类内数组序优先。
 */

import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/config.ts';
import type { PermissionConfig } from '../../src/config.ts';
import { PermissionGate } from '../../src/permission/gate.ts';
import type { PermissionRequest } from '../../src/permission/gate.ts';
import type { PermissionRule } from '../../src/permission/rules.ts';
import { findRule } from '../../src/permission/rules.ts';
import type { RiskLevel } from '../../src/types.ts';

// ---------------------------------------------------------------------------
// 测试装置
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<PermissionConfig> = {}): PermissionConfig {
  return { ...defaultConfig.permission, ...overrides };
}

function makeRequest(toolName: string, risk: RiskLevel = 'low'): PermissionRequest {
  return { sessionId: 's1', queryId: 'q1', toolName, risk, input: {} };
}

// ---------------------------------------------------------------------------
// 决策优先级：规则 > 风险策略
// ---------------------------------------------------------------------------

describe('PermissionGate 决策优先级', () => {
  it('无规则命中 → 按风险级默认策略（low → allow）', async () => {
    const gate = new PermissionGate({ config: makeConfig() });
    const outcome = await gate.check(makeRequest('echo', 'low'));
    expect(outcome.decision).toBe('allow');
    expect(outcome.source).toBe('risk_policy');
    expect(outcome.reason).toContain('风险级 low');
  });

  it('规则 deny 覆盖低风险的默认 allow', async () => {
    const rules: PermissionRule[] = [{ match: 'echo', decision: 'deny', reason: '演示：手动封禁' }];
    const gate = new PermissionGate({ config: makeConfig(), rules });
    const outcome = await gate.check(makeRequest('echo', 'low'));
    expect(outcome.decision).toBe('deny');
    expect(outcome.source).toBe('rule');
    expect(outcome.reason).toBe('演示：手动封禁');
  });

  it('规则 allow 覆盖中风险的默认 confirm，且 confirm handler 不被调用', async () => {
    let confirmCalled = false;
    const rules: PermissionRule[] = [{ match: 'fs-read', decision: 'allow', reason: '白名单目录' }];
    const gate = new PermissionGate({
      config: makeConfig(),
      rules,
      confirm: async () => ((confirmCalled = true), true),
    });
    const outcome = await gate.check(makeRequest('fs-read', 'medium'));
    expect(outcome.decision).toBe('allow');
    expect(outcome.source).toBe('rule');
    expect(confirmCalled).toBe(false); // 规则直接裁决，无需交互
  });
});

// ---------------------------------------------------------------------------
// confirm 交互流程
// ---------------------------------------------------------------------------

describe('PermissionGate confirm 流程', () => {
  it('路径一：规则要求确认 + handler 放行 → allow（source=confirm）', async () => {
    const rules: PermissionRule[] = [{ match: 'shell', decision: 'confirm', reason: '命令执行需确认' }];
    const gate = new PermissionGate({ config: makeConfig(), rules, confirm: async () => true });
    const outcome = await gate.check(makeRequest('shell', 'critical'));
    expect(outcome.decision).toBe('allow');
    expect(outcome.source).toBe('confirm');
    expect(outcome.reason).toContain('规则要求确认');
    expect(outcome.reason).toContain('用户已确认');
  });

  it('路径二：风险策略命中 confirm + handler 拒绝 → deny（理由含「用户拒绝」）', async () => {
    const gate = new PermissionGate({ config: makeConfig(), confirm: async () => false });
    const outcome = await gate.check(makeRequest('fs-write', 'high'));
    expect(outcome.decision).toBe('deny');
    expect(outcome.source).toBe('confirm');
    expect(outcome.reason).toContain('用户拒绝');
  });

  it('路径三：无确认通道（非交互环境）→ deny，理由为「无确认通道」（可区分于用户拒绝）', async () => {
    const gate = new PermissionGate({ config: makeConfig() }); // 不传 confirm
    const outcome = await gate.check(makeRequest('fs-write', 'high'));
    expect(outcome.decision).toBe('deny');
    expect(outcome.source).toBe('confirm');
    expect(outcome.reason).toContain('无确认通道');
  });

  it('路径四：handler 永不返回 → 超时按拒绝处理（理由含「超时」）', async () => {
    const gate = new PermissionGate({
      config: makeConfig({ confirmTimeoutMs: 30 }),
      confirm: () => new Promise<boolean>(() => {}), // 永不 resolve：模拟「用户离开工位」
    });
    const outcome = await gate.check(makeRequest('fs-write', 'high'));
    expect(outcome.decision).toBe('deny');
    expect(outcome.source).toBe('confirm');
    expect(outcome.reason).toContain('超时');
  });

  it('handler 抛异常 → check 永不抛，fail-safe 收敛为 deny', async () => {
    const gate = new PermissionGate({
      config: makeConfig(),
      confirm: async () => {
        throw new Error('交互通道断裂');
      },
    });
    const outcome = await gate.check(makeRequest('fs-write', 'high'));
    expect(outcome.decision).toBe('deny');
    expect(outcome.reason).toContain('fail-safe');
    expect(outcome.reason).toContain('交互通道断裂');
  });
});

// ---------------------------------------------------------------------------
// findRule 匹配语义
// ---------------------------------------------------------------------------

describe('findRule', () => {
  const rules: PermissionRule[] = [
    { match: '*', decision: 'deny', reason: '兜底通配' },
    { match: 'echo', decision: 'allow', reason: '精确规则' },
    { match: '*', decision: 'confirm', reason: '后置通配' },
  ];

  it('精确名优先于通配（即使通配在数组更靠前）', () => {
    expect(findRule(rules, 'echo')?.reason).toBe('精确规则');
  });

  it('无精确命中时取第一个通配规则（数组序）', () => {
    expect(findRule(rules, 'unknown')?.reason).toBe('兜底通配');
  });

  it('无任何命中 → undefined（调用方回退风险策略）', () => {
    expect(findRule([], 'echo')).toBeUndefined();
    expect(findRule([{ match: 'other', decision: 'deny', reason: 'x' }], 'echo')).toBeUndefined();
  });
});
