/**
 * Observability 层出口 —— Tracer（全量事件追踪）+ CostTracker（计价账本）。
 *
 * 装配方式（w14 参考实现见 scripts/lab.ts 幕 H 与 src/eval/rig.ts）：
 *   const tracer = new Tracer({ bus, config: config.observability });
 *   const cost = new CostTracker({ bus, config: config.observability });
 *   // 进程收尾：tracer.dispose(); cost.dispose();
 * 两者都是「只读消费者」：订阅、留存、可查询——不参与任何控制流。
 */

export * from './types.ts';
export * from './tracer.ts';
export * from './cost.ts';
