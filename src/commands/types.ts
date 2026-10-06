/**
 * 命令层协议 —— 「REPL 控制面」的词汇表。
 *
 * ===========================================================================
 * 必答问题：为什么命令不做成「模型可调用的工具」？
 * ===========================================================================
 * 控制面（control plane）与数据面（data plane）的分离：
 *
 *   数据面 = 模型对话本身：模型产生工具调用 → 工具执行 → 结果回喂模型。
 *     这里的每个动作都是「模型工作的一部分」。
 *
 *   控制面 = 操作这个对话系统的元动作：/status 看状态、/compact 压上下文、
 *     /skill 触发确定性流程——它们是**用户对系统的操作**，不是模型的任务。
 *
 *   如果把 /compact 做成模型可调用的工具，会发生什么？
 *     1. 模型可以（有意或无意）压缩用户的历史——用户失去对自己会话的控制权；
 *     2. /status 这类纯信息命令变成「模型可能调用也可能不调用」的不确定行为——
 *        用户问「现在什么状态」模型却答错时无从调试；
 *     3. 控制面命令常常不产生消息（无状态变更），与「工具调用必进消息链」的
 *        协议不兼容——硬塞进去会污染对话历史。
 *
 *   对照真实系统：shell 的内建命令（cd/export）也不是可执行文件——
 *   控制动作必须在「解释器层」处理，不能交给被解释的程序。
 *
 * ---------------------------------------------------------------------------
 * 依赖方向（硬约束，写进架构文档的规则）
 * ---------------------------------------------------------------------------
 *   commands → 内核模块（session/context/skills/...）：允许——命令实现
 *   可以调用一切内核能力（/compact 调 ContextManager 就是例子）。
 *
 *   内核 → commands：**禁止**——AgentLoop / SessionManager 绝不 import
 *   commands 的任何东西。命令是「挂在编排层外面的控制器」，
 *   内核不知道命令的存在（lab 幕 F 的接线顺序展示了这一点：
 *   router 在 manager 之后组装，且 manager 不认识 router）。
 */

import type { ContextManager } from '../context/manager.ts';
import type { EventBus } from '../kernel/events.ts';
import type { HookPipeline } from '../hooks/pipeline.ts';
import type { PermissionModeController } from '../permission/modes.ts';
import type { SessionManager } from '../session/session-manager.ts';
import type { SessionStore } from '../session/store.ts';
import type { SkillServices } from '../skills/index.ts';
import type { HarnessConfig } from '../config.ts';

/**
 * 命令执行上下文 —— 命令实现能触达的全部环境。
 *
 * 这是「控制面特权」的载体：命令可以同时看见编排层（manager）、存储层
 * （store）、上下文层（contextManager）、技能层（skills）——因为它们
 * 是用户意志的执行者，不受「最小权限」约束。
 *
 * 组装责任在 CLI（w17）：buildContext 回调按当前活跃会话构造此对象。
 * 可选字段（contextManager / skills）缺省时对应命令返回「未装配」提示——
 * 最小装配（如只装了 session）也能跑出可用的命令子集。
 */
export interface CommandContext {
  /** 当前活跃会话 id（/status /history /compact 的作用对象） */
  readonly sessionId: string;
  /** 编排层：会话状态机 + query 执行 */
  readonly manager: SessionManager;
  /** 存储层：消息与检查点的直接读取（/history /compact 的数据源） */
  readonly store: SessionStore;
  /** 上下文管理器（/compact 消费；未装配时为 undefined） */
  readonly contextManager?: ContextManager | undefined;
  /** 技能服务门面（/skill 消费；未装配时为 undefined） */
  readonly skills?: SkillServices | undefined;
  /**
   * 权限模式控制器（/mode 消费，w18；未装配时为 undefined）。
   * 读写同一个引用：setMode 的切换对后续每次权限检查立即生效。
   */
  readonly permissionMode?: PermissionModeController | undefined;
  /** Hook 管道（/hooks 消费，w18：只读展示已注册横切逻辑；未装配时为 undefined） */
  readonly hooks?: HookPipeline | undefined;
  /** 工具沙箱根目录（/skill 透传给技能执行器） */
  readonly workingDir: string;
  readonly bus: EventBus;
  readonly config: HarnessConfig;
}

/**
 * 命令执行的产出。
 *
 * v1 只有文本一种形态——控制面命令的输出就是「给用户看的回复」。
 * 演进点（有真实需求时再加）：'exit'（请求 REPL 退出）、'switch_session'
 * （命令切换活跃会话）等——新增 kind 时所有消费方会因穷尽检查而报错，
 * 强制处理新增语义（这正是判别联合的价值）。
 */
export interface CommandResult {
  readonly kind: 'text';
  readonly text: string;
}

/** 命令定义（注册表的元素） */
export interface CommandDefinition {
  /** 命令名（不含前缀；**必须全小写**——注册时校验，查询时归一） */
  readonly name: string;
  /** 一句话说明（/help 列表展示） */
  readonly description: string;
  /** 用法示例（/help <command> 展示；缺省显示为 "/name"） */
  readonly usage?: string;
  /**
   * 执行体。允许同步或异步（多数命令是同步读数据的；/skill 要 await
   * 技能执行）。router 统一 await，两种签名对调用方无差别。
   */
  readonly run: (
    context: CommandContext,
    args: readonly string[],
  ) => CommandResult | Promise<CommandResult>;
}
