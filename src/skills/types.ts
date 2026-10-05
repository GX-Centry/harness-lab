/**
 * 技能（Skill）协议 —— 「确定性编排」的声明形态。
 *
 * ===========================================================================
 * 与 Agent Loop 的对照（本模块存在的根本理由）
 * ===========================================================================
 *
 *   Agent Loop（自由编排）：每一步调用哪个工具、传什么参数，由 LLM 逐轮决策——
 *     灵活、可处理开放式任务，但不可预知、不可复现、每步都要花 token。
 *
 *   Skill（确定性编排）：步骤序列在代码里**写死**，中间不经过模型——
 *     可复现、可审计、零 token 成本，但只能处理「步骤已知」的场景。
 *
 * 两者不是替代关系而是分工：Loop 负责「想做什么」，Skill 负责「怎么稳定地做」。
 *
 * ---------------------------------------------------------------------------
 * 必答问题：什么任务适合 Skill 而非让模型自由调用工具？
 * ---------------------------------------------------------------------------
 *   适合 Skill（判断标准一）：步骤序列固定且已知。
 *     例：「导出报告 = 查询 → 格式化 → 写文件」。让模型每次重新决策
 *     「下一步调什么」既浪费 token 又引入随机性——闭集不值得让模型操心。
 *
 *   适合 Skill（判断标准二）：操作序列有审计/合规要求。
 *     财务、医疗、运维等场景要求「每次执行完全一致且可追溯」——
 *     模型自由编排天然做不到「每次一致」。
 *
 *   适合 Loop（判断标准三）：步骤数不确定 / 需按中间结果动态分支。
 *     例：「帮我排查为什么构建失败」——失败原因决定下一步看什么，
 *     无法预写步骤序列，必须交给模型。
 *
 *   一个实用的组合姿势（演进方向，v1 未实现）：
 *     把 Skill 包装成 Tool 暴露给模型（skill-as-tool）——模型决定「何时用」，
 *     Skill 保证「用的时候怎么走」。控制权分层：策略归模型，流程归代码。
 *
 * ---------------------------------------------------------------------------
 * 设计决策：为什么 Skill 是「数据」而 Runner 是「解释器」？
 * ---------------------------------------------------------------------------
 *   SkillDefinition 只描述「做什么」（步骤序列），不含任何执行逻辑；
 *   执行逻辑（构造 ToolCall、调 Dispatcher、失败处理）全部收敛在 runner.ts。
 *   收益：
 *     1. 注册表可以校验技能形状（空步骤、未知工具）而不执行任何东西；
 *     2. 步骤序列可被展示（/skill 命令列举）、可被测试穷举；
 *     3. 将来从外部文件加载技能（YAML/Markdown）时，加载器只需产出这组数据结构。
 */

import type { ToolResult } from '../types.ts';

// ===========================================================================
// §1 步骤声明
// ===========================================================================

/**
 * 步骤参数解析的输入（「数据流」的载体）。
 *
 * 为什么是函数而不是静态参数对象？
 *   步骤之间需要数据传递：第 2 步的输入常常是第 1 步的输出。
 *   函数让每个步骤可以「拿到前面所有步骤的结果」再决定自己的参数。
 *
 * 权衡（教学点——两种技能形态的取舍）：
 *   - 函数式（本实现）：类型安全、能做任意变换；代价是**不可序列化**——
 *     技能无法存成纯 YAML 配置，必须随代码分发。
 *   - 声明式（演进路径）：把 resolveArgs 换成模板引用（如 "{{steps.0.output}}"）
 *     即可序列化，代价是表达能力变弱（复杂变换做不了）。
 *   配置化技能库出现真实需求时再引入声明式版；v1 不做（避免过度设计）。
 */
export interface SkillStepContext {
  /**
   * 技能级输入（外部透传，整个技能共享）。
   * /skill 命令把剩余参数以 { text: "..." } 透传；代码调用可传任意键值。
   */
  readonly input: Readonly<Record<string, unknown>>;
  /**
   * 前序步骤的结果（按声明顺序；当前步骤的序号 = results.length）。
   * 执行器传入的是**快照**（浅拷贝）——步骤实现无法通过保留引用
   * 篡改后续看到的数组（防御性设计，避免「技能间隐式耦合」）。
   */
  readonly results: readonly SkillStepOutcome[];
}

/** 单个步骤的声明 */
export interface SkillStep {
  /** 要调用的工具名（必须在 ToolRegistry 中存在——runner 会在执行前整体预检） */
  readonly tool: string;
  /** 步骤说明（/skill 展示、失败定位时告诉用户「死在哪一步」） */
  readonly describe: string;
  /** 参数解析：从 input + 前序结果计算本次工具调用的参数 */
  readonly resolveArgs: (context: SkillStepContext) => Record<string, unknown>;
}

/** 技能的完整声明 */
export interface SkillDefinition {
  /** 技能名（注册表键；建议 kebab-case，与工具名风格一致） */
  readonly name: string;
  /** 技能描述（/skill 列举时展示） */
  readonly description: string;
  /** 步骤序列（至少 1 步——空技能在注册时被拒绝） */
  readonly steps: readonly SkillStep[];
}

// ===========================================================================
// §2 执行结果
// ===========================================================================

/**
 * 单步的执行结果。
 *
 * 双通道设计（与 ToolResult 的分工呼应）：
 *   - output：文本通道——给「人/模型」读的结果说明（即 ToolResult.content）；
 *   - raw：结构化通道——完整 ToolResult，需要 meta 等结构化数据的步骤从这里取。
 *   多数步骤只消费 output；当工具在 meta 里放了结构化值（如计算数值、文件行数），
 *   下游步骤应走 raw.meta 而不是正则解析 output 文本（解析文本脆弱且做法糟糕）。
 */
export interface SkillStepOutcome {
  readonly tool: string;
  readonly ok: boolean;
  /** 工具结果文本（成功=输出，失败=给模型的失败说明） */
  readonly output: string;
  /** 原始 ToolResult（结构化通道：meta 等） */
  readonly raw: ToolResult;
}

/** 失败原因分类（控制面据此给用户不同的修复提示） */
export type SkillRunFailure =
  /** 技能名不存在（调用方笔误或技能未注册） */
  | 'unknown_skill'
  /** 某步骤声明的工具未注册（执行前整体预检发现——fail-fast 前置化） */
  | 'unknown_tool'
  /** 工具执行失败（fail-fast：后续步骤不再执行） */
  | 'step_failed'
  /** 执行器自身的运行时错误（resolveArgs 抛出异常等） */
  | 'run_error';

/** 技能执行的终态（成功） */
export interface SkillRunSuccess {
  readonly ok: true;
  readonly skill: string;
  /** 全部步骤的结果（按声明顺序） */
  readonly steps: readonly SkillStepOutcome[];
  readonly durationMs: number;
}

/** 技能执行的终态（失败）——错误即数据，与 ToolResult 哲学一致 */
export interface SkillRunFailure_ {
  readonly ok: false;
  readonly skill: string;
  readonly reason: SkillRunFailure;
  /** 给用户看的失败说明（含修复提示） */
  readonly message: string;
  /** 已完成 + 失败的那一步（定位用；预检失败时为空数组） */
  readonly steps: readonly SkillStepOutcome[];
  /** 失败发生在第几步（0 基；预检/未知技能类失败无此值） */
  readonly failedAt?: number;
  readonly durationMs: number;
}

export type SkillResult = SkillRunSuccess | SkillRunFailure_;
