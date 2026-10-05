/**
 * 权限规则 —— 「什么工具、什么决策」的声明式表达。
 *
 * 规则与默认策略的关系（决策优先级）：
 *   1. 规则匹配（精确工具名 > '*' 通配；命中即用规则的决策）；
 *   2. 未命中 → 按工具声明风险级查默认策略表（config.permission.policyByRisk）。
 *
 * 教学简化与演进点：
 *   - 规则目前是扁平数组（先命中先返回）。生产形态是多层合并：
 *     CLI 参数 > 项目配置 > 用户级配置，每层可覆盖上层——合并逻辑独立于本模块；
 *   - 规则暂不支持参数级条件（如「fs_write 只允许写 docs/ 下」）。
 *     那是「策略引擎」的范畴（如 Cedar/OPA 的迷你版），属于解的明确升级路径。
 */

import type { PermissionDecision } from '../types.ts';

/** 一条权限规则 */
export interface PermissionRule {
  /** 匹配目标：工具名精确匹配，或 '*' 匹配全部 */
  readonly match: string;
  readonly decision: PermissionDecision;
  /** 决策理由（进审计与事件流——「为什么放行」和「结果是什么」同样重要） */
  readonly reason: string;
}

/**
 * 查找命中的规则。
 * 匹配优先级：精确名 > '*'；同类中数组靠前者优先。
 * （实现只需两趟查找——先扫精确，再扫通配，无需排序。）
 */
export function findRule(rules: readonly PermissionRule[], toolName: string): PermissionRule | undefined {
  const exact = rules.find((rule) => rule.match === toolName);
  if (exact !== undefined) return exact;
  return rules.find((rule) => rule.match === '*');
}
