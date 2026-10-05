/**
 * EventBus 的单元测试。
 * 锚定的决策：
 *   - seq/ts 由总线补全（时钟注入 → 完全确定的时间戳）；
 *   - 订阅顺序契约：具体类型先于通配；
 *   - 退订函数（闭包式）可靠生效；
 *   - 订阅者异常隔离（ADR-009 精神：观测不能炸主流程）。
 */

import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../src/kernel/events.ts';

describe('EventBus', () => {
  it('emit 补全单调递增 seq 与注入时钟的 ts', () => {
    const bus = new EventBus({ now: () => 1000 });
    const e1 = bus.emit({ type: 'session_created', sessionId: 's1' });
    const e2 = bus.emit({ type: 'query_start', sessionId: 's1', inputLength: 5 });
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e1.ts).toBe(1000);
    expect(e2.ts).toBe(1000);
    expect(bus.emittedCount).toBe(2);
  });

  it('具体类型订阅者先收到，通配订阅者后收到', () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.on('*', () => order.push('wildcard'));
    bus.on('session_created', () => order.push('specific'));
    bus.emit({ type: 'session_created' });
    expect(order).toEqual(['specific', 'wildcard']);
  });

  it('通配订阅收到全部事件；具体订阅只收匹配事件', () => {
    const bus = new EventBus();
    const all: string[] = [];
    const queries: string[] = [];
    bus.on('*', (e) => all.push(e.type));
    bus.on('query_start', (e) => queries.push(e.type));
    bus.emit({ type: 'session_created' });
    bus.emit({ type: 'query_start', inputLength: 1 });
    expect(all).toEqual(['session_created', 'query_start']);
    expect(queries).toEqual(['query_start']);
  });

  it('退订函数可靠生效（闭包捕获，无需配对参数）', () => {
    const bus = new EventBus();
    const seen: number[] = [];
    const off = bus.on('*', (e) => seen.push(e.seq));
    bus.emit({ type: 'session_created' });
    off();
    bus.emit({ type: 'session_created' });
    expect(seen).toEqual([1]);
  });

  it('订阅者抛异常：其他订阅者照常执行，emit 不向外抛', () => {
    const onSubscriberError = vi.fn();
    const bus = new EventBus({ onSubscriberError });
    const after: string[] = [];
    bus.on('session_created', () => {
      throw new Error('订阅者故意失败');
    });
    bus.on('session_created', () => after.push('second'));
    // emit 本身不得抛出
    expect(() => bus.emit({ type: 'session_created' })).not.toThrow();
    // 第二个订阅者不受影响
    expect(after).toEqual(['second']);
    // 错误被回调上报
    expect(onSubscriberError).toHaveBeenCalledTimes(1);
  });

  it('分发后的事件被浅冻结：篡改抛 TypeError', () => {
    const bus = new EventBus();
    const event = bus.emit({ type: 'session_created' });
    expect(Object.isFrozen(event)).toBe(true);
    expect(() => {
      (event as { seq: number }).seq = 999;
    }).toThrow(TypeError);
  });

  it('clear() 清空订阅但保留 seq 计数', () => {
    const bus = new EventBus();
    let count = 0;
    bus.on('*', () => (count += 1));
    bus.emit({ type: 'session_created' });
    bus.clear();
    bus.emit({ type: 'session_created' });
    expect(count).toBe(1);
    expect(bus.emittedCount).toBe(2);
  });
});
