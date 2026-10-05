/**
 * Session Rig —— Eval 的「完整装配」形态（第二种 rig，见 rig.ts 谱系）。
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 它与 Core Rig 的唯一差别：run 的语义从「无状态推演」变成「会话续问」    │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * Core Rig 的 run = loop.run(input, [], ctx)（空历史、不落盘）；
 * Session Rig 的 run = 状态门控恢复 + manager.runQuery（加载历史、落盘检查点）。
 * 装配本身完全共享（assembleHarness）——两种 rig 的差异恰好就是
 * 「会话层」这一层，对照阅读两个 run 实现即可看清它做了什么。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 「崩溃现场」的物理还原（场景语义的落地方式）：
 *
 *   1. 预置阶段（模拟「上一个进程」）：把 scenario.session 的消息/状态/
 *      检查点经唯一写入口 commit() 写入临时 SQLite，然后**关闭连接**；
 *   2. 重启阶段：新连接打开同一库（跨进程语义——SQLite 文件是进程间
 *      共享的媒介），构造 SessionManager；
 *   3. run：首次操作按状态门控触发 resumeSession（interrupted/processing
 *      → 补位），再走 runQuery 正常续问——与 CLI app 的「会话就位」同构。
 *
 * 为什么预置走 store.commit 而不是伪造 API？——commit 是存储层唯一写入口
 * （消息 + 检查点 + 状态同事务），用它预置得到的是**与真实崩溃完全同构**
 * 的数据库状态——恢复逻辑面对的不是特制夹具，而是真实现场。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 确定性约定（对齐 rig.ts 铁律 2）：
 *   - 库路径由场景名派生（非随机）：`<tmp>/harness-lab-eval/<场景名>.db`——
 *     同场景重复运行先清理残留再重建，任意次运行产出相同的会话轨迹；
 *   - queryId 说明：SessionManager 运行时生成 queryId（`q_<uuid>`，含随机数）——
 *     它不进入断言契约；evidence.queryId 是形状兼容的说明性占位
 *     （会话场景的断言走 evidence.session，不依赖 queryId 维度）。
 *
 * 清理纪律（w17b 的 EPERM 教训）：close 先关连接、再删库三件套
 * （.db / -wal / -shm）——顺序反了 Windows 上会因文件锁删除失败。
 *
 * 依赖方向：eval/session-rig.ts → eval/rig（共享装配）+ session/*（真会话层）。
 */

import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HarnessError } from '../errors.ts';
import type { LoopEvent, LoopResult } from '../kernel/agent-loop.ts';
import { SessionManager } from '../session/session-manager.ts';
import type { ResumeInfo } from '../session/session-manager.ts';
import { SessionStore } from '../session/store.ts';
import { assembleHarness } from './rig.ts';
import type { CoreRigOptions, RunOptions, ScenarioHarness } from './rig.ts';
import type { EvalScenario, ScenarioEvidence, SessionEvidence } from './types.ts';

// ===========================================================================
// §1 工厂
// ===========================================================================

/**
 * 创建 Session Rig（仅当场景声明了 scenario.session 时由 runner 选用——
 * 直接调用而未预置是装配错误，立即抛错而非静默降级）。
 */
export function createSessionRig(scenario: EvalScenario, options: CoreRigOptions = {}): ScenarioHarness {
  const preload = scenario.session;
  if (preload === undefined) {
    throw new HarnessError(
      'internal_error',
      `场景 "${scenario.name}" 未声明 session 预置——不应选用 Session Rig（runner 按 scenario.session 分派）`,
      { where: 'eval/session-rig' },
    );
  }

  const core = assembleHarness(scenario, options);
  const dbPath = join(tmpdir(), 'harness-lab-eval', `${scenario.name}.db`);

  // ---- 1. 预置阶段（模拟「上一个进程」的写入现场后退出）----
  removeDbFiles(dbPath); // 同场景重复运行：清理上次残留（无残留时 force 无害）
  const preseed = new SessionStore(dbPath, { now: options.now });
  try {
    preseed.createSession(core.sessionId);
    preseed.commit({
      sessionId: core.sessionId,
      deltaMessages: preload.messages,
      checkpoint: {
        id: `cp_${scenario.name}_preload`,
        turn: preload.checkpointTurn ?? 1,
        messages: preload.messages,
      },
      state: preload.state ?? 'interrupted',
      keepLast: core.config.session.checkpoint.keepLast,
    });
  } finally {
    preseed.close(); // 「进程退出」——连接关闭
  }

  // ---- 2. 重启阶段：新连接打开同一库（跨进程语义的物理还原）----
  const store = new SessionStore(dbPath, { now: options.now });
  const manager = new SessionManager({
    store,
    loop: core.loop,
    bus: core.bus,
    config: core.config,
    workingDir: core.workingDir,
    // memory 刻意不装配：记忆注入类断言是保留区（rig.ts 演进点）
  });

  // 说明性占位（见文件头确定性约定——不进入断言契约）
  const queryId = `q_session_${scenario.name}`;

  let restartHandled = false;
  let resumeReport: ResumeInfo | undefined;
  let closed = false;

  return {
    scenario: core.scenario,
    config: core.config,
    provider: core.provider,
    bus: core.bus,
    tracer: core.tracer,
    cost: core.cost,
    sessionId: core.sessionId,
    queryId,

    async run(input: string, runOptions: RunOptions = {}): Promise<ScenarioEvidence> {
      const mark = core.events.length;
      const signal = runOptions.signal ?? new AbortController().signal;

      // 重启后的首次操作：状态门控恢复（仅 interrupted/processing 走
      // resumeSession——completed/failed 直接以新 query 继续，这是「恢复
      // 专指 checkpoint 路径」的语义边界，也是状态门控负路径的断言素材）。
      if (!restartHandled) {
        restartHandled = true;
        const info = manager.getSession(core.sessionId);
        if (info !== undefined && (info.state === 'interrupted' || info.state === 'processing')) {
          resumeReport = manager.resumeSession(core.sessionId);
        }
      }

      // runQuery = 会话级编排：记忆检索（未装配→空）→ 加载历史 → Loop →
      // 轮次边界落检查点 → 终结原子提交（与 CLI/lab 走的同一条路径）。
      const loopEvents: LoopEvent[] = [];
      let result: LoopResult | undefined;
      for await (const event of manager.runQuery(core.sessionId, input, signal)) {
        loopEvents.push(event);
        if (event.type === 'completed') {
          result = event.result;
        }
      }

      const session: SessionEvidence = {
        resume: resumeReport,
        stateAfter: manager.getSession(core.sessionId)?.state,
        persistedMessages: store.loadMessages(core.sessionId),
      };

      return {
        result,
        loopEvents,
        events: core.events.slice(mark),
        requests: [...core.provider.requests],
        cost: core.cost,
        sessionId: core.sessionId,
        queryId,
        session,
      };
    },

    close(): void {
      if (closed) return; // 幂等（runner 的 finally 可能重复调用）
      closed = true;
      try {
        store.close();
      } finally {
        // 先关连接再删库（Windows 文件锁的 EPERM 教训——见文件头清理纪律）
        removeDbFiles(dbPath);
        core.dispose();
      }
    },
  };
}

// ===========================================================================
// §2 内部辅助
// ===========================================================================

/** 删除 SQLite 库三件套（.db / -wal / -shm；force 容忍不存在） */
function removeDbFiles(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
}
