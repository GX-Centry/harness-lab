/**
 * 权限模式（Permission Mode）—— 「全自动 / 半自动 / 全手动」三档运行姿态。
 *
 * ===========================================================================
 * 必答问题：模式与「决策三态」是什么关系？（见 types.ts 的 PermissionMode）
 * ===========================================================================
 *   决策三态（allow / confirm / deny）是**单次调用**的结局；
 *   模式是**一段时间的运行姿态**——它只回答一个问题：
 *   「当决策链走到 confirm 时，还要不要真的去问人？」
 *
 *   三档语义（本文件 + gate.ts 共同兑现）：
 *     manual → 每个 confirm 都走确认交互（readline / Web 横幅 / …）；
 *     semi   → low/medium 自动放行；high/critical 仍走确认交互；
 *     auto   → confirm 决策自动批准（**不经过**确认交互）。
 *
 *   三个不变量（三档都不改变——这是「保留安全边界」的底线）：
 *     ① 规则层的显式 deny 仍然拒绝（模式只影响 confirm 层，不影响规则裁决）；
 *     ② hook 的 block 仍然阻断（发生在权限检查之前的管道里）；
 *     ③ fail-safe 缺省不变：manual/semi 下无确认通道仍拒绝——auto 是
 *        用户**显式声明**的「无人值守」姿态，不是「通道缺失」的兜底。
 *
 * ---------------------------------------------------------------------------
 * 为什么是「控制器」而不是「一个字符串」？
 * ---------------------------------------------------------------------------
 * 模式需要**运行期切换**（CLI 的 /mode 命令、Web 的设置面板）——切换必须
 * 立刻影响后续每一次权限检查。控制器（可变的单一真源）被门禁按引用持有：
 *   - 门禁每次 check 时读取 controller.mode——无需重建任何装配；
 *   - CLI 横幅 / Web chip / /mode 命令 / /api/permission-mode 全部读写
 *     同一对象，不存在「两份模式状态」的漂移可能。
 *
 * 依赖方向：permission/modes.ts → types.ts（仅 PermissionMode/RiskLevel 类型）。
 * 本文件运行时零依赖（type-only import 全部被擦除）——刻意保持，使 config.ts
 * 也能安全地引用 PermissionMode（避免 permission ⇄ config 的循环）。
 */

import type { PermissionMode, RiskLevel } from '../types.ts';

// ===========================================================================
// §1 常量与解析
// ===========================================================================

/** 全部合法模式（注册顺序 = 展示顺序：manual → semi → auto，安全带由紧到松） */
export const PERMISSION_MODES = ['manual', 'semi', 'auto'] as const;

/**
 * semi 模式自动批准的风险级集合（「半自动」的边界定义）。
 * low/medium 自动放行（查资料、只读、按模板写报告——低破坏面动作）；
 * high/critical 仍走确认交互（写文件、删除、不可逆操作——人必须点头）。
 */
export const SEMI_AUTO_APPROVE_RISK: readonly RiskLevel[] = ['low', 'medium'];

/**
 * 解析模式字符串（CLI 参数 / 环境变量共用）。大小写不敏感（用户输入的
 * 'AUTO'、'Semi' 都应被接受——环境变量的书写习惯不可预测）。
 * 未知值返回 undefined（由调用方决定：CLI 参数报错退出 / 环境变量警告回退）。
 */
export function parsePermissionMode(value: string): PermissionMode | undefined {
  const normalized = value.trim().toLowerCase();
  return (PERMISSION_MODES as readonly string[]).includes(normalized)
    ? (normalized as PermissionMode)
    : undefined;
}

/** 一句话描述（横幅 / /mode / Web 面板共用——同一事实同一表述） */
export function describePermissionMode(mode: PermissionMode): string {
  switch (mode) {
    case 'manual':
      return '全手动：每个确认决策都询问用户';
    case 'semi':
      return '半自动：low/medium 自动放行，high/critical 仍询问';
    case 'auto':
      return '全自动：确认决策自动批准（规则 deny 仍拦截）';
  }
}

// ===========================================================================
// §2 运行时控制器
// ===========================================================================

/**
 * 模式控制器：持有当前模式的可变单一真源。
 * 门禁 / 命令 / Web API 共享同一实例——「模式」永远只有一个真相。
 */
export interface PermissionModeController {
  /** 当前模式（每次读取都取最新值——门禁在每次 check 时读取） */
  readonly mode: PermissionMode;
  /** 切换模式（/mode 命令、Web API、测试驱动） */
  setMode(mode: PermissionMode): void;
}

/** 创建控制器（初始模式来自 CLI 参数 / 环境变量 / config——由装配层决定） */
export function createPermissionModeController(initial: PermissionMode): PermissionModeController {
  let current = initial;
  return {
    get mode(): PermissionMode {
      return current;
    },
    setMode(mode: PermissionMode): void {
      current = mode;
    },
  };
}
