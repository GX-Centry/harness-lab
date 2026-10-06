/* ============================================================================
 * harness-lab 网页控制台 · 前端（零依赖：原生 JS + EventSource）
 * ----------------------------------------------------------------------------
 * 心脏是「回放引擎」：服务器把双通道（HarnessEvent + LoopEvent）合并成一条
 * 按到达顺序编号（n）的 wire 流并全量重放给每个新连接；前端所有状态都从
 * 这条 wire 纯函数式重建——
 *
 *   buildModel(wire, cursor)   只读 wire[0..cursor]，返回完整 UI 模型
 *   renderAll()                把模型映射成 DOM（无状态渲染）
 *
 * 于是「实时 / 单步 / 变速播放 / 拖动回看 / 刷新重看」共享同一套逻辑：
 * 移动 cursor 即移动时间。实时 = cursor 钉在队头；单步 = cursor+1。
 *
 * 双通道归因（工具四步链如何在 UI 合体）——到达顺序契约由 agent-loop 的
 * yield 位置保证：loop:tool_started(args) → harness:assembled → hook_* →
 * permission_decision → harness:tool_started → harness:tool_finished →
 * loop:tool_finished(result)。卡片以 toolCallId 合并双通道；不带 id 的
 * hook/permission 事件归因「最近未关闭的 assembled」（工具串行执行无歧义）；
 * 子世界的 assembled 找不到卡片时自然降级为仅时间线。
 * ========================================================================= */
'use strict';

// ============================== §0 DOM 引用 ==============================

const $ = (id) => document.getElementById(id);

const el = {
  conn: $('conn-badge'), sessionChip: $('session-chip'), btnReset: $('btn-reset'),
  stages: $('stages'), conversation: $('conversation'), presets: $('presets'),
  form: $('composer-form'), input: $('input'), btnSend: $('btn-send'), btnAbort: $('btn-abort'),
  filters: $('filters'), timeline: $('timeline'), layers: $('layers'),
  btnRewind: $('btn-rewind'), btnStep: $('btn-step'), btnPlay: $('btn-play'),
  playIcon: $('play-icon'), playLabel: $('play-label'), speed: $('speed'),
  progress: $('progress'), progressLabel: $('progress-label'),
  newBadge: $('new-badge'), btnLive: $('btn-live'),
  banner: $('confirm-banner'), cfTool: $('cf-tool'), cfRisk: $('cf-risk'), cfArgs: $('cf-args'),
  cfApprove: $('cf-approve'), cfDeny: $('cf-deny'),
  // 服务设置弹层（Provider 热切换 + 连通测试）
  providerChip: $('provider-chip'), modeChip: $('mode-chip'), btnSettings: $('btn-settings'),
  overlay: $('settings-overlay'), btnSettingsClose: $('btn-settings-close'),
  spPreset: $('sp-preset'), spPresetHint: $('sp-preset-hint'), spBaseurl: $('sp-baseurl'),
  spModel: $('sp-model'), spApikey: $('sp-apikey'), spResult: $('sp-result'),
  btnTest: $('btn-test'), btnDemo: $('btn-demo'), btnApply: $('btn-apply'),
};

// ============================== §1 静态定义 ==============================

const STAGE_DEFS = [
  { no: '01', name: '输入', desc: 'query 进入内核；斜杠命令在此被拦截（不进模型）' },
  { no: '02', name: '上下文组装', desc: '分层 token 预算 + 记忆检索 + 压缩链' },
  { no: '03', name: '模型调用', desc: '请求 → 流式分片 → 终态（usage / stopReason）' },
  { no: '04', name: '工具分发 · 四步链', desc: '受理 → Hooks·前 → 权限 → 执行 → Hooks·后' },
  { no: '05', name: '结果回写', desc: '消息落盘 + checkpoint；工具结果回注下一轮' },
  { no: '06', name: '循环控制', desc: '有工具调用→回②；否则终止（stopReason 收敛）' },
];

const LAYER_DEFS = [
  { id: 'permission', name: '权限层', icon: 'i-shield', color: 'var(--amber)', desc: '风险策略 + 人工确认（ConfirmHandler 注入点）' },
  { id: 'hooks', name: 'Hook 层', icon: 'i-hook', color: 'var(--violet)', desc: 'pre/post 管道：可观测、可改写、可阻断' },
  { id: 'skills', name: '命令 · 技能层', icon: 'i-terminal', color: 'var(--orange)', desc: '命令在进 LLM 之前拦截；技能是确定性编排' },
  { id: 'session', name: '会话层', icon: 'i-session', color: 'var(--cyan)', desc: '状态机 + 消息持久化 + checkpoint + 崩溃补位' },
  { id: 'memory', name: '记忆层', icon: 'i-memory', color: 'var(--rose)', desc: '跨会话长期记忆：检索注入 + 写回' },
  { id: 'subagent', name: '子代理层', icon: 'i-users', color: 'var(--teal)', desc: 'Agent-as-Tool：独立子世界（独立 Provider / 事件 / 权限链）' },
  { id: 'observe', name: '可观测层', icon: 'i-chart', color: 'var(--blue)', desc: 'usage 成本 / 重试 / 错误——只看不动的旁路' },
];

const HOOK_KIND_ZH = { continue: '继续', modify_input: '改写参数', modify_result: '改写结果', block: '阻断', skip: '跳过' };

/** HarnessEvent → 中文标签 / 归层 / 语气 / 摘要 */
const EVENT_INFO = {
  session_created: { layer: 'session', tone: 'muted', label: '会话创建', sum: () => '壳装配时建立' },
  session_resumed: { layer: 'session', tone: 'ok', label: '会话恢复', sum: (e) => `checkpoint ${clip(e.checkpointId, 10)}（中断补位）` },
  session_state_change: { layer: 'session', tone: 'muted', label: '状态迁移', sum: (e) => `${e.from} → ${e.to}` },
  query_start: { phase: 0, tone: 'info', label: '查询开始', sum: (e) => `输入 ${e.inputLength} 字符（原文不进事件）` },
  query_end: { phase: 5, tone: 'ok', label: '查询结束', sum: (e) => `${e.stopReason} · ${e.turns} 轮 · in ${e.usage.inputTokens}/out ${e.usage.outputTokens} tok` },
  llm_request: { phase: 2, tone: 'info', label: '请求模型', sum: (e) => `${e.model} · ${e.messageCount} 消息 · ${e.toolCount} 工具 · ~${e.approxInputTokens} tok` },
  llm_response: { phase: 2, tone: 'ok', label: '模型返回', sum: (e) => `${e.stopReason} · ${e.toolCallCount} 调用 · ${e.latencyMs}ms · out ${e.usage.outputTokens} tok` },
  llm_retry: { phase: 2, layer: 'observe', tone: 'warn', label: '模型重试', sum: (e) => `第 ${e.attempt}/${e.maxAttempts} 次 · ${e.code} · ${e.delayMs}ms 后重试` },
  tool_call_assembled: { phase: 3, tone: 'info', label: '④-0 受理', sum: (e) => `${e.name} · 组装${e.parseOk ? '成功' : '失败→快速路径'}` },
  hook_invoked: { phase: 3, layer: 'hooks', tone: 'muted', label: '④-1 Hook', sum: (e) => `${e.hookName} @ ${e.event}` },
  hook_outcome: { phase: 3, layer: 'hooks', tone: 'info', label: '④-1 Hook 结果', sum: (e) => `${e.hookName} → ${HOOK_KIND_ZH[e.kind] ?? e.kind}` },
  hook_error: { phase: 3, layer: 'hooks', tone: 'warn', label: '④-1 Hook 异常', sum: (e) => `${e.hookName} · ${e.message}` },
  permission_decision: { phase: 3, layer: 'permission', tone: (e) => (e.decision === 'allow' ? 'ok' : 'warn'), label: '④-2 权限', sum: (e) => `${e.toolName} · 风险 ${e.risk} → ${e.decision}（${e.reason}）` },
  tool_started: { phase: 3, tone: 'info', label: '④-3 执行', sum: (e) => e.name },
  tool_finished: { phase: 3, tone: (e) => (e.ok ? 'ok' : 'err'), label: '④-4 完成', sum: (e) => `${e.name} · ${e.ok ? 'ok' : (e.errorCode ?? 'fail')} · ${e.durationMs}ms` },
  context_built: { phase: 1, tone: 'muted', label: '上下文组装', sum: (e) => `${e.totalTokens} tok · 分层 ${Object.keys(e.layerTokens).length} 段${e.compressed ? ' · 已压缩' : ''}` },
  context_compressed: { phase: 1, tone: 'warn', label: '上下文压缩', sum: (e) => `L${e.level} · 丢 ${e.droppedMessages} 条 / ${e.droppedTokens} tok` },
  message_persisted: { phase: 4, layer: 'session', tone: 'muted', label: '消息落盘', sum: (e) => `role=${e.role}` },
  checkpoint_saved: { phase: 4, layer: 'session', tone: 'muted', label: '检查点', sum: (e) => `第 ${e.turn} 轮 · ${clip(e.checkpointId, 10)}` },
  memory_retrieved: { phase: 1, layer: 'memory', tone: 'muted', label: '记忆检索', sum: (e) => `命中 ${e.count} 条 · top ${Number(e.topScore).toFixed(2)}` },
  memory_written: { phase: 4, layer: 'memory', tone: 'ok', label: '记忆写入', sum: (e) => `${e.kind} · ${clip(e.recordId, 10)}` },
  usage_recorded: { layer: 'observe', tone: 'muted', label: '成本记账', sum: (e) => `${e.usage.inputTokens}+${e.usage.outputTokens} tok · $${Number(e.estimatedCostUsd).toFixed(4)}` },
  command_invoked: { phase: 0, layer: 'skills', tone: 'info', label: '命令拦截', sum: (e) => `/${e.command}（不进模型）` },
  command_finished: { phase: 0, layer: 'skills', tone: 'ok', label: '命令完成', sum: (e) => `/${e.command} · ${e.ok ? 'ok' : 'fail'} · ${e.durationMs}ms` },
  skill_started: { layer: 'skills', tone: 'info', label: '技能开始', sum: (e) => e.skill },
  skill_finished: { layer: 'skills', tone: 'ok', label: '技能完成', sum: (e) => `${e.skill} · ${e.durationMs}ms` },
  subagent_started: { phase: 3, layer: 'subagent', tone: 'info', label: '子代理启动', sum: (e) => `${e.subagent} · 任务 ${e.taskLength} 字符` },
  subagent_finished: { phase: 3, layer: 'subagent', tone: 'ok', label: '子代理完成', sum: (e) => `${e.subagent} · ${e.ok ? 'ok' : 'fail'}` },
  error: { layer: 'observe', tone: 'err', label: '错误', sum: (e) => `${e.code}${e.where ? ' @' + e.where : ''} · ${e.message}` },
  log: { layer: 'observe', tone: 'muted', label: '日志', sum: (e) => `[${e.level}] ${e.message}` },
};

const PRESETS = [
  ['计算 123 * 45', '工具四步链：低风险直通'],
  ['帮我调研 harness 的安全性', '子代理 + 权限确认（medium 触发横幅）'],
  ['你好', '纯模型回合（无工具）'],
  ['/status', '命令拦截：不进模型'],
  ['/compact', '上下文组装 dry-run'],
  ['/skill math-report 21*2', '技能：确定性编排（不进模型）'],
  ['/mode semi', '权限模式：半自动（low/medium 自动放行）'],
  ['/help', '命令清单'],
  ['请记住：我偏好简短的回答', '观察记忆层是否写回'],
];

const FILTERS = [['all', '全部'], ['H', '主链路'], ['L', '对话流'], ['U', '系统']];

// ============================== §2 客户端状态与小工具 ==============================

const state = {
  wire: [],          // 收到的全部线缆消息
  lastN: 0,          // 去重水位（重连会收到重放前缀）
  cursor: -1,        // 回放揭示进度（-1 = 无内容）
  following: true,   // 是否钉在队头（实时模式）
  playing: false,    // 自动播放中
  speed: 1,
  filter: 'all',
  liveBusy: false,   // 实时忙闲（与回放 cursor 无关）
  sessionId: null,
  providerMeta: null, // 当前 Provider 元数据（hello 快照 / provider_changed 增量）
  permissionMode: null, // 权限模式（hello 快照 / permission_mode_changed 增量；w18）
};

let rafId = 0;
function scheduleRender() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => { rafId = 0; renderAll(); });
}

function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = String(text);
  return n;
}

function svgIcon(id, cls) {
  const NS = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('class', cls ?? 'icon');
  const u = document.createElementNS(NS, 'use');
  u.setAttribute('href', '#' + id);
  s.appendChild(u);
  return s;
}

function clip(text, n) {
  const s = String(text ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function fmtTime(ms) {
  const d = new Date(ms);
  const p = (x, w = 2) => String(x).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function setConn(kind, text) {
  el.conn.className = 'badge ' + (kind === 'ok' ? 'badge-ok' : kind === 'err' ? 'badge-err' : 'badge-wait');
  el.conn.textContent = text;
}

// ============================== §3 回放引擎：buildModel ==============================

/**
 * 纯函数：从 wire[0..upto] 重建完整 UI 模型。
 * 不读写任何外部状态——「实时 / 单步 / 回放」共用同一渲染路径。
 */
function buildModel(wire, upto) {
  const model = {
    conv: [],           // 对话块：[user | turn | command | notice]
    timeline: [],       // 时间线行
    stages: STAGE_DEFS.map(() => ({ state: 'idle', value: '' })),
    layers: {},
    sys: { busy: false, toolCalls: 0, llmCalls: 0, persisted: 0, checkpoints: 0, turns: 0, stopReason: null },
    pending: null,      // 待决权限确认
  };
  for (const def of LAYER_DEFS) model.layers[def.id] = { items: [], count: 0, active: false };

  const toolCards = new Map();   // toolCallId → 卡片（对话区实体）
  const stack = [];              // 归因栈：「最近未关闭 assembled」的 id 序列
  let curTurn = null;            // 当前 assistant 轮次块

  const pushTl = (m, ch, label, sum, tone) => {
    model.timeline.push({ n: m.n, at: m.at, ch, label, sum, tone });
  };
  const pushLayer = (id, at, text) => {
    const L = model.layers[id];
    L.items.push({ at, text });
    L.count += 1;
    if (L.items.length > 40) L.items.shift();
  };
  const advance = (idx) => {
    for (let j = 0; j < idx; j += 1) if (model.stages[j].state === 'active') model.stages[j].state = 'done';
    if (model.stages[idx].state !== 'done') model.stages[idx].state = 'active';
  };
  const resetFrom = (idx) => {
    for (let j = idx; j < 6; j += 1) { model.stages[j].state = 'idle'; model.stages[j].value = ''; }
  };
  const topCard = () => {
    const top = stack[stack.length - 1];
    return top === undefined ? null : (toolCards.get(top) ?? null);
  };

  const limit = Math.min(upto, wire.length - 1);
  for (let i = 0; i <= limit; i += 1) {
    const m = wire[i];

    // ---------------------------------------------------------- ui 频道
    if (m.ch === 'ui') {
      if (m.type === 'query_submitted') {
        model.sys.busy = true;
        model.conv.push({ kind: 'user', text: m.input });
        pushTl(m, 'U', '提交输入', clip(m.input, 44), 'muted');
      } else if (m.type === 'query_done') {
        model.sys.busy = false;
        pushTl(m, 'U', '查询收尾', m.ok ? '流正常结束' : '有错误（见上）', m.ok ? 'muted' : 'err');
        if (!m.ok) model.conv.push({ kind: 'notice', text: '本轮以异常收尾——详见事件线', err: true });
      } else if (m.type === 'query_error') {
        model.conv.push({ kind: 'notice', text: `致命异常：${m.message}`, err: true });
        pushTl(m, 'U', '致命异常', m.message, 'err');
      } else if (m.type === 'permission_prompt') {
        model.pending = { toolName: m.toolName, risk: m.risk, input: m.input };
        model.layers.permission.active = true;
        pushTl(m, 'U', '等待人工确认', `${m.toolName}（${m.risk}）——横幅已弹出`, 'warn');
      } else if (m.type === 'permission_settled') {
        model.pending = null;
        model.layers.permission.active = false;
        pushTl(m, 'U', '人工确认结果', m.approved ? '已批准' : m.reason === 'timeout' ? '超时→自动拒绝' : '已拒绝', m.approved ? 'ok' : 'warn');
      } else if (m.type === 'provider_changed') {
        pushTl(m, 'U', '模型来源切换', m.provider.kind === 'demo' ? '离线演示（规则 Provider）' : `${m.provider.model} @ ${m.provider.baseUrl}`, 'ok');
      } else if (m.type === 'reset') {
        model.conv.length = 0;
        model.timeline.length = 0;
        model.sys = { busy: false, toolCalls: 0, llmCalls: 0, persisted: 0, checkpoints: 0, turns: 0, stopReason: null };
        for (const def of LAYER_DEFS) model.layers[def.id] = { items: [], count: 0, active: false };
        resetFrom(0);
        toolCards.clear(); stack.length = 0; curTurn = null;
        pushTl(m, 'U', '新会话', m.sessionId, 'muted');
        model.conv.push({ kind: 'notice', text: `已切换到新会话 ${m.sessionId}（同库记忆保留）`, err: false });
      }
      continue;
    }

    // -------------------------------------------------------- loop 频道
    if (m.ch === 'loop') {
      if (m.kind === 'command_text') {
        model.conv.push({ kind: 'command', text: m.text });
        pushTl(m, 'L', '命令输出', clip(m.text, 70), 'muted');
        continue;
      }
      const ev = m.event;
      if (m.kind === 'turn_started') {
        model.sys.turns = ev.turn;
        curTurn = { kind: 'turn', turn: ev.turn, parts: [], streaming: true };
        model.conv.push(curTurn);
        advance(5);
        model.stages[5].value = `第 ${ev.turn} 轮`;
        pushTl(m, 'L', `第 ${ev.turn} 轮开始`, '循环控制：继续下一轮', 'info');
      } else if (m.kind === 'text_delta') {
        if (curTurn) {
          const last = curTurn.parts[curTurn.parts.length - 1];
          if (last && last.type === 'text') last.text += ev.text;
          else curTurn.parts.push({ type: 'text', text: ev.text });
        }
        if (model.stages[2].state !== 'done') model.stages[2].state = 'active';
      } else if (m.kind === 'thinking_delta') {
        if (curTurn) {
          const last = curTurn.parts[curTurn.parts.length - 1];
          if (last && last.type === 'thinking') last.text += ev.text;
          else curTurn.parts.push({ type: 'thinking', text: ev.text });
        }
      } else if (m.kind === 'tool_started') {
        const card = ensureCard(toolCards, ev.toolCallId, ev.name, curTurn, model);
        card.args = ev.args;
        pushTl(m, 'L', `调用 ${ev.name}`, `参数 ${clip(JSON.stringify(ev.args), 52)}`, 'info');
      } else if (m.kind === 'tool_finished') {
        const card = ensureCard(toolCards, ev.toolCallId, ev.name, curTurn, model);
        if (!card.result) card.result = ev.result;
        pushTl(m, 'L', `${ev.name} 返回`, `${ev.result.ok ? 'ok' : 'fail'} · ${clip(ev.result.content, 52)}`, ev.result.ok ? 'ok' : 'err');
      } else if (m.kind === 'completed') {
        const r = ev.result;
        model.sys.stopReason = r.stopReason;
        model.stages[5].state = 'done';
        model.stages[5].value = `终止：${r.stopReason} · ${r.turns} 轮`;
        if (curTurn) curTurn.streaming = false;
        pushTl(m, 'L', '循环终止', `${r.stopReason} · ${r.turns} 轮 · in ${r.usage.inputTokens}/out ${r.usage.outputTokens} tok`, r.stopReason === 'error' ? 'err' : 'ok');
      }
      continue;
    }

    // ----------------------------------------------------- harness 频道
    const e = m.event;
    const isSub = typeof e.queryId === 'string' && e.queryId.includes('>'); // 子世界
    const info = EVENT_INFO[e.type];
    if (info) {
      const tone = typeof info.tone === 'function' ? info.tone(e) : (info.tone ?? 'muted');
      pushTl(m, 'H', (isSub ? '子·' : '') + (info.label ?? e.type), info.sum ? info.sum(e) : '', tone);
      if (info.layer && !isSub) pushLayer(info.layer, m.at, info.sum ? info.sum(e) : e.type);
    }

    // 子世界内部事件不驱动主链路六阶段（子世界有自己的小循环）
    if (isSub && e.type !== 'subagent_started' && e.type !== 'subagent_finished') continue;

    switch (e.type) {
      case 'query_start':
        resetFrom(1);
        model.stages[0].state = 'active';
        model.stages[0].value = `输入 ${e.inputLength} 字符`;
        break;
      case 'command_invoked':
        advance(0);
        model.stages[0].value = `拦截 /${e.command}（不进模型）`;
        break;
      case 'command_finished':
        model.stages[0].state = 'done';
        model.stages[0].value = `/${e.command} 完成 · ${e.durationMs}ms`;
        break;
      case 'context_built':
        advance(1);
        model.stages[1].value = `${e.totalTokens} tok${e.compressed ? ' · 已压缩' : ''}`;
        break;
      case 'context_compressed':
        advance(1);
        model.stages[1].value = `压缩 L${e.level}：-${e.droppedMessages} 条`;
        break;
      case 'memory_retrieved':
        advance(1);
        if (e.count > 0) model.stages[1].value = `记忆注入 ${e.count} 条（top ${Number(e.topScore).toFixed(2)}）`;
        break;
      case 'memory_written':
        advance(4);
        break;
      case 'llm_request':
        advance(2);
        model.sys.llmCalls += 1;
        model.stages[2].value = `~${e.approxInputTokens} tok · ${e.messageCount} 消息`;
        break;
      case 'llm_response':
        model.stages[2].state = 'done';
        model.stages[2].value = `out ${e.usage.outputTokens} tok · ${e.latencyMs}ms · ${e.stopReason}`;
        break;
      case 'tool_call_assembled': {
        advance(3);
        stack.push(e.toolCallId);
        const card0 = toolCards.get(e.toolCallId);
        if (card0) card0.steps.accepted = true;
        model.stages[3].value = `${e.name} · 组装${e.parseOk ? '✓' : '✗'}`;
        break;
      }
      case 'hook_invoked':
      case 'hook_outcome':
      case 'hook_error': {
        const card = topCard();
        if (card) {
          if (e.type === 'hook_invoked') card.steps.preHooks = true;
          const cls = e.type === 'hook_error' ? 'bad' : 'hook';
          const text = e.type === 'hook_invoked' ? `${e.hookName} @ ${e.event}`
            : e.type === 'hook_outcome' ? `${e.hookName} → ${HOOK_KIND_ZH[e.kind] ?? e.kind}`
              : `${e.hookName} ✗ ${e.message}`;
          card.notes.push({ cls, tag: 'Hook', text });
        }
        break;
      }
      case 'permission_decision': {
        const card = topCard();
        if (card) {
          card.steps.permission = true;
          card.notes.push({
            cls: e.decision === 'allow' ? 'ok' : 'bad', tag: '权限',
            text: `${e.decision === 'allow' ? '放行' : '拒绝'} · 风险 ${e.risk} · ${e.reason}`,
          });
        }
        break;
      }
      case 'tool_started': {
        const card = toolCards.get(e.toolCallId);
        if (card) card.steps.executed = true;
        break;
      }
      case 'tool_finished': {
        const card = toolCards.get(e.toolCallId);
        if (card) {
          card.steps.postHooks = true;
          card.harness = { ok: e.ok, durationMs: e.durationMs, errorCode: e.errorCode };
          card.done = true;
        }
        const at = stack.indexOf(e.toolCallId);
        if (at >= 0) stack.splice(at, 1); // 闭合归因
        model.stages[3].value = `${e.name} · ${e.ok ? 'ok' : (e.errorCode ?? 'fail')} · ${e.durationMs}ms`;
        break;
      }
      case 'message_persisted':
        advance(4);
        model.sys.persisted += 1;
        model.stages[4].value = `已落盘 ${model.sys.persisted} 条`;
        break;
      case 'checkpoint_saved':
        advance(4);
        model.sys.checkpoints += 1;
        model.stages[4].value = `checkpoint #${e.turn} · 已落盘 ${model.sys.persisted} 条`;
        break;
      case 'subagent_started':
        model.layers.subagent.active = true;
        advance(3);
        break;
      case 'subagent_finished':
        model.layers.subagent.active = false;
        break;
      case 'query_end':
        model.stages[5].state = 'done';
        for (let j = 0; j < 6; j += 1) if (model.stages[j].state === 'active') model.stages[j].state = 'done';
        break;
      default:
        break;
    }
  }
  return model;
}

/** 卡片注册表：loop / harness 任一通道先到都可创建（幂等） */
function ensureCard(toolCards, id, name, curTurn, model) {
  let card = toolCards.get(id);
  if (card === undefined) {
    card = {
      type: 'tool', toolCallId: id, name,
      args: undefined, result: undefined, harness: null, done: false,
      steps: { accepted: false, preHooks: false, permission: false, executed: false, postHooks: false },
      notes: [],
    };
    toolCards.set(id, card);
    if (curTurn) curTurn.parts.push(card);
    model.sys.toolCalls += 1;
    model.stages[3].value = `${name} · 受理中…`;
  }
  return card;
}

// ============================== §4 渲染层 ==============================

let flash = null; // 瞬时提示（不参与回放，3.5s 后消失）

function renderAll() {
  const model = buildModel(state.wire, state.cursor);
  renderStages(model);
  renderConversation(model);
  renderTimeline(model);
  renderLayers(model);
  renderBanner(model);
  renderControls();
}

function renderStages(model) {
  el.stages.textContent = '';
  STAGE_DEFS.forEach((def, i) => {
    const s = model.stages[i];
    const li = h('li', 'stage' + (s.state === 'active' ? ' s-active' : s.state === 'done' ? ' s-done' : ''));
    li.appendChild(h('div', 'stage-no', def.no));
    const body = h('div', 'stage-body');
    body.appendChild(h('div', 'stage-name', def.name));
    body.appendChild(h('div', 'stage-desc', def.desc));
    if (s.value) body.appendChild(h('div', 'stage-value mono', s.value));
    li.appendChild(body);
    li.appendChild(h('span', 'dot dot-' + s.state));
    el.stages.appendChild(li);
  });
}

const openThink = new Set(); // <details> 展开状态（跨渲染保持）

function renderConversation(model) {
  const box = el.conversation;
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
  box.textContent = '';

  if (model.conv.length === 0) {
    const empty = h('div', 'empty');
    empty.appendChild(h('p', undefined, '还没有对话。点下方预设按钮或直接输入，观察左侧六阶段与右侧七层的联动。'));
    empty.appendChild(h('p', 'dim', '建议路径：先「计算 123 * 45」看工具分发四步链 → 再「帮我调研」触发权限确认横幅 → 再「/status」看命令拦截（不进模型）。'));
    box.appendChild(empty);
  } else {
    model.conv.forEach((item, idx) => {
      if (item.kind === 'user') {
        box.appendChild(h('div', 'msg-user', item.text));
      } else if (item.kind === 'command') {
        box.appendChild(h('div', 'msg-command', item.text));
      } else if (item.kind === 'notice') {
        box.appendChild(h('div', 'msg-notice' + (item.err ? ' notice-err' : ''), item.text));
      } else if (item.kind === 'turn') {
        const wrap = h('div', 'turn');
        const head = h('div', 'turn-head');
        head.appendChild(h('span', undefined, `第 ${item.turn} 轮`));
        head.appendChild(h('span', 'via', '⟵ 模型调用'));
        wrap.appendChild(head);
        item.parts.forEach((part, pi) => {
          if (part.type === 'text') {
            const isLast = pi === item.parts.length - 1;
            wrap.appendChild(h('div', 'msg-text' + (item.streaming && isLast ? ' streaming' : ''), part.text));
          } else if (part.type === 'thinking') {
            const key = `${idx}-${pi}`;
            const det = document.createElement('details');
            det.className = 'msg-thinking';
            det.open = openThink.has(key);
            det.addEventListener('toggle', () => { if (det.open) openThink.add(key); else openThink.delete(key); });
            det.appendChild(h('summary', undefined, '思考（展示用·不注入历史）'));
            det.appendChild(h('div', 'think-body', part.text));
            wrap.appendChild(det);
          } else if (part.type === 'tool') {
            wrap.appendChild(renderToolCard(part));
          }
        });
        box.appendChild(wrap);
      }
    });
  }
  if (flash !== null) box.appendChild(h('div', 'msg-notice', flash));
  if (atBottom || state.following) box.scrollTop = box.scrollHeight;
}

function renderToolCard(card) {
  const okState = card.harness ? card.harness.ok : card.result ? card.result.ok : null;
  const root = h('div', 'tool-card' + (okState === null ? ' tc-pending' : okState ? ' tc-ok' : ' tc-fail'));
  const head = h('div', 'tc-head');
  head.appendChild(svgIcon('i-tool'));
  head.appendChild(h('span', 'tc-name mono', card.name));
  const st = h('span', 'tc-state mono');
  if (card.harness) {
    st.textContent = card.harness.ok ? `ok · ${card.harness.durationMs}ms` : `${card.harness.errorCode ?? 'fail'} · ${card.harness.durationMs}ms`;
    st.classList.add(card.harness.ok ? 'ok' : 'fail');
  } else if (card.result) {
    st.textContent = card.result.ok ? 'ok' : 'fail';
    st.classList.add(card.result.ok ? 'ok' : 'fail');
  } else {
    st.textContent = '执行中…';
    st.classList.add('pending');
  }
  head.appendChild(st);
  root.appendChild(head);

  // 四步链进度（受理 → Hooks·前 → 权限 → 执行 → Hooks·后）
  const steps = h('div', 'tc-steps');
  const stepDefs = [['accepted', '① 受理'], ['preHooks', '② Hooks·前'], ['permission', '③ 权限'], ['executed', '④ 执行'], ['postHooks', '⑤ Hooks·后']];
  for (const [key, label] of stepDefs) {
    const s = h('span', 'step', label);
    if (card.steps[key]) s.classList.add('step-done');
    else if (card.done) s.classList.add('step-skip');
    steps.appendChild(s);
  }
  root.appendChild(steps);

  if (card.args !== undefined) {
    const row = h('div', 'tc-row');
    row.appendChild(h('span', 'tc-k', '参数'));
    row.appendChild(h('code', undefined, clip(JSON.stringify(card.args), 240)));
    root.appendChild(row);
  }
  if (card.result) {
    const row = h('div', 'tc-row');
    row.appendChild(h('span', 'tc-k', '结果'));
    row.appendChild(h('code', undefined, clip(card.result.content, 480)));
    root.appendChild(row);
  }
  if (card.notes.length > 0) {
    const notes = h('div', 'tc-notes');
    for (const note of card.notes.slice(-6)) {
      const line = h('div', 'tc-note');
      line.appendChild(h('span', 'tag ' + note.cls, note.tag));
      line.appendChild(h('span', undefined, note.text));
      notes.appendChild(line);
    }
    root.appendChild(notes);
  }
  return root;
}

function renderTimeline(model) {
  const box = el.timeline;
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
  box.textContent = '';
  const rows = model.timeline.filter((r) => state.filter === 'all' || r.ch === state.filter);
  rows.forEach((r, i) => {
    const row = h('div', 'tl-row t-' + r.tone + (i === rows.length - 1 ? ' tl-head' : ''));
    row.appendChild(h('span', 'tl-n mono', String(r.n)));
    row.appendChild(h('span', 'tl-time mono', fmtTime(r.at)));
    row.appendChild(h('span', 'tl-ch ch-' + r.ch.toLowerCase(), r.ch));
    const body = h('span');
    body.appendChild(h('span', 'tl-type', r.label));
    if (r.sum) body.appendChild(h('span', 'tl-sum', r.sum));
    row.appendChild(body);
    box.appendChild(row);
  });
  if (atBottom || state.following) box.scrollTop = box.scrollHeight;
}

function renderLayers(model) {
  el.layers.textContent = '';
  for (const def of LAYER_DEFS) {
    const L = model.layers[def.id];
    const sec = h('section', 'layer' + (L.active ? ' layer-active' : ''));
    sec.style.setProperty('--layer-color', def.color);
    const head = h('div', 'layer-head');
    head.appendChild(svgIcon(def.icon));
    head.appendChild(h('h3', undefined, def.name));
    head.appendChild(h('span', 'layer-count mono', L.count > 0 ? String(L.count) : ''));
    sec.appendChild(head);
    sec.appendChild(h('p', 'layer-desc', def.desc));
    const ul = h('ul', 'layer-items');
    if (L.items.length === 0) {
      ul.appendChild(h('li', 'li-empty', '暂无活动'));
    } else {
      for (const item of L.items.slice(-5).reverse()) {
        const li = h('li');
        li.appendChild(h('span', 'li-t mono', fmtTime(item.at).slice(0, 8)));
        li.appendChild(h('span', undefined, clip(item.text, 64)));
        ul.appendChild(li);
      }
    }
    sec.appendChild(ul);
    el.layers.appendChild(sec);
  }
}

let confirmClicked = false;

function renderBanner(model) {
  if (model.pending) {
    el.banner.hidden = false;
    el.cfTool.textContent = model.pending.toolName;
    el.cfRisk.textContent = model.pending.risk;
    el.cfRisk.className = 'risk risk-' + model.pending.risk;
    el.cfArgs.textContent = clip(JSON.stringify(model.pending.input ?? {}), 90);
    el.cfApprove.disabled = confirmClicked;
    el.cfDeny.disabled = confirmClicked;
  } else {
    el.banner.hidden = true;
    confirmClicked = false;
  }
}

function renderControls() {
  const len = state.wire.length;
  const max = Math.max(0, len - 1);
  const cur = Math.max(0, Math.min(state.cursor, max));
  el.progress.max = String(max);
  el.progress.value = String(cur);
  el.progress.style.setProperty('--fill', (max > 0 ? (cur / max) * 100 : 0) + '%');
  el.progressLabel.textContent = `${Math.max(0, cur + 1)} / ${len}`;
  const pendingNew = state.following ? 0 : Math.max(0, max - state.cursor);
  el.newBadge.hidden = pendingNew <= 0;
  el.newBadge.textContent = `+${pendingNew} 新事件`;
  el.playIcon.setAttribute('href', state.playing ? '#i-pause' : '#i-play');
  el.playLabel.textContent = state.playing ? '暂停' : state.following ? '播放' : '继续';
  el.btnRewind.disabled = len === 0;
  el.btnStep.disabled = len === 0 || state.cursor >= max;
  el.btnLive.disabled = state.following;
  el.btnSend.disabled = state.liveBusy;
  el.btnAbort.hidden = !state.liveBusy;
  el.input.disabled = state.liveBusy;
  el.btnReset.disabled = state.liveBusy;
}

// ============================== §5 回放控制 ==============================

let playTimer = 0;
const tickMs = () => Math.round(600 / state.speed);

function playTick() {
  clearTimeout(playTimer);
  if (!state.playing) return;
  const max = state.wire.length - 1;
  if (state.cursor >= max) {
    state.playing = false;
    state.following = true; // 追到队头 → 无缝切回实时跟随
    scheduleRender();
    return;
  }
  state.cursor += 1;
  scheduleRender();
  playTimer = setTimeout(playTick, tickMs());
}

function startPlaying() {
  if (state.wire.length === 0) return;
  if (state.cursor >= state.wire.length - 1) state.cursor = -1; // 已在队头：从头播放
  state.playing = true;
  state.following = false;
  scheduleRender();
  playTick();
}

function stopPlaying() {
  state.playing = false;
  clearTimeout(playTimer);
}

function stepBy(delta) {
  stopPlaying();
  const max = state.wire.length - 1;
  state.cursor = Math.max(0, Math.min(state.cursor + delta, max));
  state.following = state.cursor >= max;
  scheduleRender();
}

function rewind() {
  if (state.wire.length === 0) return;
  stopPlaying();
  state.cursor = 0;
  state.following = false;
  scheduleRender();
  startPlaying();
}

function goLive() {
  stopPlaying();
  state.cursor = state.wire.length - 1;
  state.following = true;
  scheduleRender();
}

// ============================== §6 SSE 接入 ==============================

function onWireMessage(msg) {
  if (typeof msg.n !== 'number' || msg.n <= state.lastN) return; // 去重
  state.lastN = msg.n;
  if (msg.ch === 'ui' && msg.type === 'reset') {
    state.wire = [msg]; // 服务器已开新会话：本地从头重建
    state.lastN = msg.n;
    state.cursor = 0;
    state.following = true;
    stopPlaying();
    state.sessionId = msg.sessionId;
    el.sessionChip.textContent = msg.sessionId;
  } else {
    state.wire.push(msg);
    if (state.following) state.cursor = state.wire.length - 1;
  }
  if (msg.ch === 'ui') {
    if (msg.type === 'query_submitted') state.liveBusy = true;
    if (msg.type === 'query_done' || msg.type === 'query_error') state.liveBusy = false;
    if (msg.type === 'provider_changed') setProviderMeta(msg.provider);
    if (msg.type === 'permission_mode_changed') setModeMeta(msg.mode, msg.description);
  }
  scheduleRender();
}

function connect() {
  setConn('wait', '连接中…');
  const es = new EventSource('/api/stream');
  es.addEventListener('hello', (ev) => {
    try {
      const info = JSON.parse(ev.data);
      state.sessionId = info.sessionId;
      el.sessionChip.textContent = info.sessionId;
      el.sessionChip.title = `会话状态：${info.state ?? '?'}`;
      state.liveBusy = Boolean(info.busy);
      if (info.provider) setProviderMeta(info.provider);
      if (info.permissionMode) setModeMeta(info.permissionMode, info.permissionModeDescription);
      setConn('ok', '已连接');
    } catch { /* 忽略畸形 hello */ }
  });
  es.onmessage = (ev) => {
    try { onWireMessage(JSON.parse(ev.data)); } catch { /* 忽略畸形消息 */ }
  };
  es.onerror = () => setConn('wait', '重连中…');
}

// ===================== §6.5 服务设置（Provider 热切换） =====================

/**
 * 「服务设置」弹层：预设服务商自由选择 / 自定义 URL 连通测试 / 应用热切换。
 * 应用走 POST /api/provider（服务器重建装配，会话与记忆无缝延续）；
 * key 只存在本机浏览器（表单回填）与服务器内存——不落盘、不入库、不回显。
 */
const SETTINGS_KEY = 'hl-provider-form';
const DEMO_VALUE = '__demo__';

let presetsCache = null; // GET /api/provider 的预设表（首次打开时拉取）

/** 顶栏徽章：演示=灰「演示」；真实=绿「模型名」（title 带端点详情） */
function setProviderMeta(info) {
  if (!info) return;
  state.providerMeta = info;
  const real = info.kind === 'real';
  el.providerChip.className = 'chip chip-provider mono' + (real ? ' chip-real' : '');
  el.providerChip.textContent = real ? String(info.model ?? '真实 API') : '演示';
  el.providerChip.title = real
    ? `真实 API：${info.model} @ ${info.baseUrl}${info.hasApiKey ? '' : '（未配置 key）'}`
    : '离线演示：规则 Provider（确定性、无网络）——点右侧「服务设置」切换';
}

/**
 * 权限模式徽章（w18）：manual=中性灰 / semi=琥珀 / auto=绿；点击循环切换。
 * 描述文案由服务端下发（与 CLI 同源）——前端不重写一份。
 */
const MODE_CYCLE = { manual: 'semi', semi: 'auto', auto: 'manual' };

function setModeMeta(mode, description) {
  if (!mode) return;
  state.permissionMode = mode;
  el.modeChip.textContent = mode;
  const next = MODE_CYCLE[mode] ?? 'manual';
  el.modeChip.title = `${description ? description + '——' : ''}点击切换（${mode} → ${next}）`;
  el.modeChip.className = 'chip chip-mode mono mode-' + mode;
}

/** 点击徽章：切到下一档（POST 成功后由 permission_mode_changed 广播回填——单一回写路径） */
async function cyclePermissionMode() {
  const next = MODE_CYCLE[state.permissionMode] ?? 'manual';
  try {
    const r = await fetch('/api/permission-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: next }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) flashNotice(String(data.error ?? `请求失败（${r.status}）`));
  } catch (error) {
    flashNotice('网络错误：' + String(error));
  }
}

/** 表单 → localStorage（仅本机浏览器；打开弹层时回填） */
function saveProviderForm() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      presetId: el.spPreset.value,
      baseUrl: el.spBaseurl.value,
      model: el.spModel.value,
      apiKey: el.spApikey.value,
    }));
  } catch { /* 无痕模式等场景——忽略 */ }
}

/** 预设切换：同步禁用态与提示；overwrite=true 时用预设填充字段 */
function onPresetChange(overwrite) {
  const id = el.spPreset.value;
  const isDemo = id === DEMO_VALUE;
  el.spBaseurl.disabled = isDemo;
  el.spModel.disabled = isDemo;
  el.spApikey.disabled = isDemo;
  el.btnTest.disabled = isDemo;
  if (isDemo) {
    el.spPresetHint.textContent = '规则 Provider：离线确定性演示，无网络调用（无需配置）';
    return;
  }
  const preset = presetsCache ? presetsCache.find((p) => p.id === id) : null;
  if (!preset) { el.spPresetHint.textContent = ''; return; }
  el.spPresetHint.textContent = preset.hint ?? '';
  if (overwrite) {
    el.spBaseurl.value = preset.baseUrl;
    el.spModel.value = preset.model;
    if (!preset.needsKey) el.spApikey.value = ''; // 本地服务：清掉可能残留的 key
  }
}

async function openSettings() {
  el.overlay.hidden = false;
  el.spResult.hidden = true;
  await ensurePresets();
  restoreProviderForm();
}

function closeSettings() {
  el.overlay.hidden = true;
}

async function ensurePresets() {
  if (presetsCache !== null) return;
  try {
    const r = await fetch('/api/provider');
    const data = await r.json();
    if (data.provider) setProviderMeta(data.provider);
    presetsCache = Array.isArray(data.presets) ? data.presets : [];
    buildPresetOptions(presetsCache);
  } catch { /* 网络错误：保留空表，下次打开重试 */ }
}

function buildPresetOptions(presets) {
  el.spPreset.textContent = '';
  el.spPreset.appendChild(new Option('离线演示（无需配置）', DEMO_VALUE));
  for (const p of presets) el.spPreset.appendChild(new Option(p.label, p.id));
}

/** 回填优先级：本机保存的表单 → 当前运行的 Provider 元数据 → 离线演示 */
function restoreProviderForm() {
  if (el.spPreset.options.length === 0) return;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null'); } catch { /* 忽略损坏数据 */ }
  const meta = state.providerMeta;
  const savedId = saved ? String(saved.presetId ?? '') : '';
  const known = savedId === DEMO_VALUE || (presetsCache ?? []).some((p) => p.id === savedId);
  if (saved !== null && known) {
    el.spPreset.value = savedId;
    el.spBaseurl.value = String(saved.baseUrl ?? '');
    el.spModel.value = String(saved.model ?? '');
    el.spApikey.value = String(saved.apiKey ?? '');
  } else if (meta && meta.kind === 'real') {
    const metaId = String(meta.presetId ?? '');
    el.spPreset.value = (presetsCache ?? []).some((p) => p.id === metaId) ? metaId : 'custom';
    el.spBaseurl.value = meta.baseUrl ?? '';
    el.spModel.value = meta.model ?? '';
    el.spApikey.value = '';
  } else {
    el.spPreset.value = DEMO_VALUE;
  }
  onPresetChange(false);
}

/** 结果框：kind ∈ ok / err / wait */
function showProviderResult(kind, lines) {
  const box = el.spResult;
  box.hidden = false;
  box.className = 'sp-result sp-' + kind;
  box.textContent = '';
  for (const line of lines) box.appendChild(h('div', undefined, line));
}

function setProviderBusy(busy) {
  el.btnTest.disabled = busy || el.spPreset.value === DEMO_VALUE;
  el.btnApply.disabled = busy;
  el.btnDemo.disabled = busy;
}

/** 连通测试（纯探测，不改变当前 Provider）：POST /api/provider/test */
async function runConnectionTest() {
  const baseUrl = el.spBaseurl.value.trim();
  if (baseUrl === '') { showProviderResult('err', ['请先填写 Base URL']); return; }
  showProviderResult('wait', [`正在探测 ${baseUrl} …（先试 GET /models；失败且已填模型名则改用最小对话请求）`]);
  setProviderBusy(true);
  try {
    const r = await fetch('/api/provider/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl, model: el.spModel.value.trim(), apiKey: el.spApikey.value.trim() }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { showProviderResult('err', [String(data.error ?? `请求失败（${r.status}）`)]); return; }
    if (data.ok === true && data.mode === 'models') {
      const models = Array.isArray(data.models) ? data.models : [];
      showProviderResult('ok', [
        `✓ 连通正常（GET /models）· ${data.latencyMs}ms`,
        models.length > 0
          ? `模型列表：${models.slice(0, 8).join(', ')}${models.length > 8 ? ` …（共 ${models.length} 个）` : ''}`
          : '（该服务未在 /models 列出模型）',
      ]);
    } else if (data.ok === true) {
      const usage = data.usage ?? {};
      showProviderResult('ok', [
        `✓ 对话正常（最小请求）· ${data.latencyMs}ms`,
        `模型回复：${clip(String(data.reply ?? ''), 120)}`,
        `usage：in ${usage.inputTokens ?? '?'} / out ${usage.outputTokens ?? '?'} tok`,
      ]);
    } else {
      const lines = [`✗ 探测失败：${String(data.error ?? '未知错误')}`];
      if (data.hint) lines.push(String(data.hint));
      lines.push(`耗时 ${data.latencyMs}ms`);
      showProviderResult('err', lines);
    }
  } catch (error) {
    showProviderResult('err', ['网络错误：' + String(error)]);
  } finally {
    setProviderBusy(false);
  }
}

/** 应用热切换（forceDemo=true 是「切回离线演示」按钮——无视下拉当前值） */
async function applyProviderForm(forceDemo) {
  const isDemo = forceDemo === true || el.spPreset.value === DEMO_VALUE;
  let payload;
  if (isDemo) {
    payload = { kind: 'demo' };
  } else {
    const baseUrl = el.spBaseurl.value.trim();
    const model = el.spModel.value.trim();
    if (baseUrl === '') { showProviderResult('err', ['Base URL 不能为空']); return; }
    if (!/^https?:\/\//.test(baseUrl)) { showProviderResult('err', ['Base URL 必须以 http:// 或 https:// 开头']); return; }
    if (model === '') { showProviderResult('err', ['模型名不能为空']); return; }
    payload = { kind: 'real', baseUrl, model, apiKey: el.spApikey.value.trim(), presetId: el.spPreset.value };
  }
  showProviderResult('wait', [isDemo ? '正在切回离线演示…' : `正在切换到 ${payload.model} …（会话无缝延续）`]);
  setProviderBusy(true);
  try {
    const r = await fetch('/api/provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { showProviderResult('err', [String(data.error ?? `请求失败（${r.status}）`)]); return; }
    saveProviderForm();
    if (data.provider) setProviderMeta(data.provider);
    closeSettings();
    flashNotice(isDemo ? '已切回离线演示' : `已切换到真实 API：${payload.model}`);
  } catch (error) {
    showProviderResult('err', ['网络错误：' + String(error)]);
  } finally {
    setProviderBusy(false);
  }
}

// ============================== §7 交互 ==============================

function flashNotice(text) {
  flash = text;
  scheduleRender();
  setTimeout(() => { if (flash === text) { flash = null; scheduleRender(); } }, 3500);
}

async function submitInput(text) {
  const input = String(text ?? '').trim();
  if (input === '') return;
  if (state.liveBusy) { flashNotice('已有查询在运行——先中断或等待完成'); return; }
  try {
    const r = await fetch('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      flashNotice(data.error ?? `请求失败（${r.status}）`);
    }
  } catch (error) {
    flashNotice('网络错误：' + String(error));
  }
}

async function settleConfirm(approve) {
  confirmClicked = true;
  scheduleRender();
  try {
    await fetch('/api/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approve }),
    });
  } catch { /* 服务器有 120s 超时兜底 */ }
}

function bindEvents() {
  el.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = el.input.value;
    el.input.value = '';
    void submitInput(text);
  });
  el.btnAbort.addEventListener('click', () => { void fetch('/api/abort', { method: 'POST' }).catch(() => {}); });
  el.btnReset.addEventListener('click', async () => {
    if (state.liveBusy) { flashNotice('查询进行中——先中断再重置'); return; }
    try { await fetch('/api/reset', { method: 'POST' }); } catch { flashNotice('网络错误'); }
  });
  el.cfApprove.addEventListener('click', () => { void settleConfirm(true); });
  el.cfDeny.addEventListener('click', () => { void settleConfirm(false); });
  el.modeChip.addEventListener('click', () => { void cyclePermissionMode(); });

  // 服务设置弹层
  el.btnSettings.addEventListener('click', () => { void openSettings(); });
  el.btnSettingsClose.addEventListener('click', closeSettings);
  el.overlay.addEventListener('click', (e) => { if (e.target === el.overlay) closeSettings(); });
  el.spPreset.addEventListener('change', () => { onPresetChange(true); saveProviderForm(); });
  for (const input of [el.spBaseurl, el.spModel, el.spApikey]) {
    input.addEventListener('input', saveProviderForm);
  }
  el.btnTest.addEventListener('click', () => { void runConnectionTest(); });
  el.btnDemo.addEventListener('click', () => { void applyProviderForm(true); });
  el.btnApply.addEventListener('click', () => { void applyProviderForm(false); });

  el.btnRewind.addEventListener('click', rewind);
  el.btnStep.addEventListener('click', () => { stepBy(1); });
  el.btnLive.addEventListener('click', goLive);
  el.btnPlay.addEventListener('click', () => {
    if (state.playing) {
      stopPlaying();
      state.following = state.cursor >= state.wire.length - 1;
      scheduleRender();
    } else {
      startPlaying();
    }
  });
  el.speed.addEventListener('change', () => { state.speed = Number(el.speed.value) || 1; });
  el.progress.addEventListener('input', () => {
    stopPlaying();
    state.cursor = Number(el.progress.value);
    state.following = state.cursor >= state.wire.length - 1;
    scheduleRender();
  });
  el.newBadge.addEventListener('click', goLive);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.overlay.hidden) { closeSettings(); return; }
    const tag = e.target && e.target.tagName ? e.target.tagName : '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.code === 'Space') { e.preventDefault(); el.btnPlay.click(); }
    else if (e.code === 'ArrowRight') { e.preventDefault(); stepBy(1); }
    else if (e.code === 'ArrowLeft') { e.preventDefault(); stepBy(-1); }
    else if (e.key === 'r' || e.key === 'R') rewind();
    else if (e.key === 'l' || e.key === 'L') goLive();
  });
}

// ============================== §8 启动 ==============================

function buildPresets() {
  for (const [text, tip] of PRESETS) {
    const b = h('button', 'preset', text);
    b.type = 'button';
    b.title = tip;
    b.addEventListener('click', () => { void submitInput(text); });
    el.presets.appendChild(b);
  }
}

function buildFilters() {
  for (const [key, label] of FILTERS) {
    const b = h('button', 'fbtn' + (state.filter === key ? ' active' : ''), label);
    b.type = 'button';
    b.dataset.f = key;
    b.addEventListener('click', () => {
      state.filter = key;
      for (const btn of el.filters.children) btn.classList.toggle('active', btn.dataset.f === key);
      scheduleRender();
    });
    el.filters.appendChild(b);
  }
}

buildPresets();
buildFilters();
bindEvents();
renderAll();
connect();

