/**
 * PermissionGate —— 权限决策的唯一入口（决策三态：allow / confirm / deny）。
 *
 * 决策优先级（三条来源，顺序是刻意的）：
 *   1. **规则匹配**（rules.ts）：显式声明优先于推导；
 *   2. **风险级默认策略**（config.permission.policyByRisk）：规则之外的兜底；
 *   3. **权限模式**（modes.ts，w18 新增）：决策链走到 confirm 时，按当前模式
 *      决定「自动批准」还是「真的去问人」——manual 全问 / semi 自动放行
 *      low+medium / auto 全部自动批准。
 *   confirm 决策统一走「确认交互」——CLI 询问、未来 Web 形态下异步等待。
 *
 * 三个重要的设计语义：
 *   - **确认必须抽象成接口**（ConfirmHandler）：CLI 是「终端询问」，
 *     Web 是「异步等待多客户端事件」——形态差异收敛在 handler 实现里，
 *     本模块的决策逻辑对交互形态零假设（这是为预留模块 Web-SSE 铺的路）；
 *   - **fail-safe（失败安全）**：无确认通道 → 拒绝；确认超时 → 拒绝。
 *     「无人应答时放行」是最危险的失败方向，任何不确定都倾向 deny；
 *   - **模式不越权**：模式只在 confirm 层生效——规则 deny 仍拒绝、
 *     hook block 仍阻断（模式改变的是「要不要问人」，不是「能不能做」）；
 *   - **决策即数据**：gate 只返回决策与理由，不执行、不抛错、不发事件——
 *     事件由 Dispatcher 统一上报（权限模块零外部依赖，纯函数化便于测试）。
 *
 * 依赖方向：permission/gate.ts → config.ts / types.ts / rules.ts / modes.ts。
 */

import type { PermissionConfig } from '../config.ts';
import type { PermissionDecision, RiskLevel } from '../types.ts';
import { SEMI_AUTO_APPROVE_RISK } from './modes.ts';
import type { PermissionModeController } from './modes.ts';
import type { PermissionRule } from './rules.ts';
import { findRule } from './rules.ts';

// ===========================================================================
// §1 输入输出形状
// ===========================================================================

/** 一次权限检查的请求（Dispatcher 构造） */
export interface PermissionRequest {
  readonly sessionId: string;
  readonly queryId: string;
  readonly toolName: string;
  readonly risk: RiskLevel;
  /** 即将执行的参数（供未来做「参数级策略」与确认展示；当前决策不依赖它） */
  readonly input: unknown;
}

/** 决策来源：规则 / 风险策略 / 权限模式 / 确认交互（审计价值：知道「为什么是这个决策」） */
export type PermissionDecisionSource = 'rule' | 'risk_policy' | 'mode' | 'confirm';

/** 决策结果 */
export interface PermissionOutcome {
  readonly decision: 'allow' | 'deny';
  readonly source: PermissionDecisionSource;
  /** 理由（进事件流与审计；confirm 场景下包含「用户确认/拒绝/超时」） */
  readonly reason: string;
}

/**
 * 确认交互处理器：返回 true = 用户放行，false = 用户拒绝。
 * 实现方负责展示上下文（工具名/风险/参数摘要）并获取反馈。
 * CLI 实现见 w17；Web 形态下就是「等待某客户端响应」。
 */
export type ConfirmHandler = (request: PermissionRequest) => Promise<boolean>;

export interface PermissionGateOptions {
  /** 权限域配置（策略表 + 确认超时） */
  readonly config: PermissionConfig;
  /** 规则表（可空；空表时全部走风险策略） */
  readonly rules?: readonly PermissionRule[];
  /**
   * 确认交互实现。缺省时任何 confirm 需求都直接拒绝（fail-safe）——
   * 这在「非交互环境」（CI、测试）里是正确的默认行为。
   */
  readonly confirm?: ConfirmHandler;
  /**
   * 权限模式控制器（w18）。缺省 = manual（全部确认都询问）——
   * 与加模式之前的行为完全一致（向后兼容）。
   * 持有引用而非快照：模式在运行期可切换（/mode、Web API），
   * 每次 check 读取最新值。
   */
  readonly mode?: PermissionModeController;
}

// ===========================================================================
// §2 决策实现
// ===========================================================================

/**
 * 确认交互的四种结局。
 * 为什么把「超时 / 无通道 / 明确拒绝」分开记录？审计需要区分「没等到」
 * 「根本没人接」和「明确拒绝」——三者的运维信号完全不同（CI 里出现
 * unavailable 是配置缺失的信号，而 deny 是用户的真实意图）。
 */
type ConfirmResult = 'allow' | 'deny' | 'timeout' | 'unavailable';

export class PermissionGate {
  private readonly config: PermissionConfig;
  private readonly rules: readonly PermissionRule[];
  private readonly confirm: ConfirmHandler | undefined;
  private readonly mode: PermissionModeController | undefined;

  constructor(options: PermissionGateOptions) {
    this.config = options.config;
    this.rules = options.rules ?? [];
    this.confirm = options.confirm;
    this.mode = options.mode;
  }

  /**
   * 执行一次权限检查。
   * 契约：永不抛错；任何内部异常都被收敛为 deny（fail-safe 的最后一道防线）。
   */
  async check(request: PermissionRequest): Promise<PermissionOutcome> {
    try {
      return await this.decide(request);
    } catch (raw) {
      const message = raw instanceof Error ? raw.message : String(raw);
      return { decision: 'deny', source: 'risk_policy', reason: `权限检查异常（fail-safe 拒绝）: ${message}` };
    }
  }

  private async decide(request: PermissionRequest): Promise<PermissionOutcome> {
    // 1) 规则优先（显式声明优先于推导——deny/allow 的规则裁决与模式无关）
    const rule = findRule(this.rules, request.toolName);
    if (rule !== undefined && rule.decision !== 'confirm') {
      return { decision: rule.decision, source: 'rule', reason: rule.reason };
    }

    // 2) 风险级默认策略（无规则命中时才生效）
    const policy: PermissionDecision = this.config.policyByRisk[request.risk];
    if (rule === undefined && policy !== 'confirm') {
      return {
        decision: policy,
        source: 'risk_policy',
        reason: `默认策略：风险级 ${request.risk} → ${policy}`,
      };
    }

    // 3) 走到这里 = 需要 confirm（规则或策略要求）——先过权限模式：
    //    auto：全部自动批准；semi：low/medium 自动批准（高风险级仍询问）
    const auto = this.autoApproveByMode(request.risk);
    if (auto !== undefined) return auto;

    // 4) manual（或 semi 的高风险级）：走确认交互（fail-safe 语义不变）
    const baseReason =
      rule !== undefined ? `规则要求确认（${rule.reason}）` : `风险级 ${request.risk} 需要确认（默认策略）`;
    return this.confirmFlow(request, baseReason);
  }

  /**
   * 权限模式的自动批准判定（w18）。返回 undefined = 该由确认交互处理。
   *
   * 为什么放在 gate（而不是包装 ConfirmHandler）？
   *   confirmFlow 的结局文案会写「用户已确认/拒绝」——模式自动批准**不是**
   *   用户确认。若靠装饰 handler 实现，审计理由会说谎（「用户已确认」但
   *   用户根本不在场）。在决策链上先行短路，理由才能如实写「模式自动批准」
   *   （source='mode'）——审计与 Web 观察面板看到的都是真相。
   */
  private autoApproveByMode(risk: RiskLevel): PermissionOutcome | undefined {
    const mode = this.mode?.mode; // 缺省控制器 = manual（向后兼容）
    if (mode === 'auto') {
      return {
        decision: 'allow',
        source: 'mode',
        reason: `权限模式 auto：风险级 ${risk} 自动批准（未询问用户）`,
      };
    }
    if (mode === 'semi' && SEMI_AUTO_APPROVE_RISK.includes(risk)) {
      return {
        decision: 'allow',
        source: 'mode',
        reason: `权限模式 semi：风险级 ${risk} ≤ medium，自动批准（未询问用户）`,
      };
    }
    return undefined;
  }

  /** 确认流程：调用 ConfirmHandler + 超时保护（超时 = 拒绝） */
  private async confirmFlow(request: PermissionRequest, baseReason: string): Promise<PermissionOutcome> {
    const result = await this.runConfirmWithTimeout(request);
    const suffix =
      result === 'allow'
        ? '用户已确认'
        : result === 'deny'
          ? '用户拒绝'
          : result === 'timeout'
            ? '确认超时（按拒绝处理）'
            : '无确认通道（fail-safe 拒绝）';
    return {
      decision: result === 'allow' ? 'allow' : 'deny',
      source: 'confirm',
      reason: `${baseReason} → ${suffix}`,
    };
  }

  private async runConfirmWithTimeout(request: PermissionRequest): Promise<ConfirmResult> {
    const handler = this.confirm;
    if (handler === undefined) {
      return 'unavailable'; // fail-safe：没有交互通道就无法确认 → 拒绝
    }
    const timeoutMs = this.config.confirmTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<ConfirmResult>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      });
      const confirmation: Promise<ConfirmResult> = handler(request).then((allowed) =>
        allowed ? 'allow' : 'deny',
      );
      return await Promise.race([confirmation, timeout]);
    } finally {
      // 无论哪边先完成，定时器都要清理——否则进程被悬挂的 timer 拖住
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
