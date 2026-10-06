/**
 * System Prompt 构建器（w18）—— 「模型面暴露」的载体。
 *
 * ===========================================================================
 * 必答问题：为什么 system prompt 需要「构建器」而不是一个写死的字符串？
 * ===========================================================================
 * 接入真实 API 后暴露的第一类断点：**模型不知道自己拥有什么**。
 *   - 工具在 registry 里注册了，但 system prompt 是演示时代的静态文案
 *     （「你是 harness-lab 的演示助手」）——模型对工具面/技能面的认知
 *     完全来自 API 的 tools 参数，自然语言指导（「什么样的请求该用哪个
 *     技能」）无处表达；
 *   - 技能（skill-as-tool）注册进工具面后，模型需要一句「技能是确定性
 *     流程，优先调用」的引导，否则它不知道 skill_ 前缀工具与普通工具的
 *     关系，可能绕过技能逐步手动调用底层工具。
 *
 * 构建器的产出是**纯函数**：同样的输入产生逐字节相同的字符串。
 *   - 输入是装配层已经确定的事实（工具清单 / 技能清单 / 环境信息）；
 *   - 无时间戳、无随机数——测试可直接断言全文，且真实 Provider 的
 *     prompt 缓存（prefix caching）能稳定命中（system 段逐轮不变）。
 *
 * 边界（刻意不做的事）：
 *   - 不把权限模式写进 prompt——模式可运行期切换（/mode），而 system
 *     prompt 在装配期定型；写进去会立刻过期。模式是「用户对系统的姿态」，
 *     不是模型需要知道的事（模型只需在工具被拒时读失败原因）；
 *   - 不注入时间/会话 id 这类易变事实——那属于消息层而非准则层。
 *
 * 依赖方向：context/system-prompt.ts → types.ts（仅类型）。零运行时依赖。
 */

// ===========================================================================
// §1 输入形状
// ===========================================================================

/** 工具面的一项（来自 ToolRegistry.list()——装配层投影） */
export interface PromptToolInfo {
  readonly name: string;
  readonly description: string;
}

/** 技能面的一项（来自 SkillRegistry.list()——装配层投影） */
export interface PromptSkillInfo {
  /** 技能原始名（如 math-report） */
  readonly name: string;
  /** 模型可见的工具名（skill_ 前缀，如 skill_math-report——与 tool-wrapper 同源） */
  readonly toolName: string;
  readonly description: string;
  readonly stepCount: number;
}

export interface SystemPromptInput {
  /** 工作目录（文件类工具的沙箱根——模型应知道相对路径解析到哪里） */
  readonly workingDir: string;
  /** 平台标识（process.platform——模型可据此调整 shell/路径习惯） */
  readonly platform: string;
  /** 工具面清单（含子代理工具与技能工具——全部已注册） */
  readonly tools: readonly PromptToolInfo[];
  /** 技能清单（可为空——空时省略技能段） */
  readonly skills: readonly PromptSkillInfo[];
}

// ===========================================================================
// §2 构建实现
// ===========================================================================

/**
 * 组装 system prompt。
 *
 * 结构（四段，顺序即优先级）：
 *   ① 身份与准则 —— 模型是谁、行为边界；
 *   ② 运行环境   —— 工作目录 / 平台（影响路径与命令习惯的事实）；
 *   ③ 技能指南   —— 技能的定位与调用姿势（前提：模型能在工具面看到它们）；
 *   ④ 工具速览   —— 工具名与职责的一行摘要（补充 tools 参数的声明）。
 */
export function buildSystemPrompt(input: SystemPromptInput): string {
  const sections: string[] = [];

  // ① 身份与准则
  sections.push(
    [
      '你是 harness-lab 的 Agent 助手——一个可检查、可扩展的 Agent Harness 的控制主体。',
      '',
      '行为准则：',
      '- 回答简洁、诚实；不确定时明说不确定，不编造事实与工具输出。',
      '- 需要外部动作时使用可用工具；工具失败时阅读失败原因并自我修正。',
      '- 文件类工具的相对路径以工作目录为根；不要请求工作目录之外的路径。',
    ].join('\n'),
  );

  // ② 运行环境
  sections.push(['运行环境：', `- 工作目录：${input.workingDir}`, `- 平台：${input.platform}`].join('\n'));

  // ③ 技能指南（仅在存在技能时输出）
  if (input.skills.length > 0) {
    const skillLines = input.skills.map(
      (skill) => `- ${skill.toolName}：${skill.description}（确定性流程，${skill.stepCount} 步）`,
    );
    sections.push(
      [
        '技能（skill-as-tool）：',
        '技能是写死的确定性步骤序列——当用户请求与某个技能匹配时，优先调用对应的 skill_ 工具，',
        '而不是逐步手动调用底层工具：技能更稳定、步骤可复现、且同样经过完整权限检查。',
        ...skillLines,
      ].join('\n'),
    );
  }

  // ④ 工具速览
  if (input.tools.length > 0) {
    const toolLines = input.tools.map((tool) => `- ${tool.name}：${tool.description}`);
    sections.push(['可用工具：', ...toolLines].join('\n'));
  }

  return sections.join('\n\n');
}
