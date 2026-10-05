/**
 * 配置中心的单元测试（教学点：每个设计决策至少有一个测试锚定）。
 * 锚定的决策：
 *   - 深合并语义（少写字段不覆盖默认值，undefined 视为未提供）；
 *   - 深冻结（运行期篡改立即报错——不可变契约）；
 *   - 启动期校验（非法配置抛 config_error，而不是运行到一半才炸）。
 */

import { describe, expect, it } from 'vitest';
import { defaultConfig, defineConfig } from '../../src/config.ts';
import { HarnessError } from '../../src/errors.ts';

describe('defineConfig', () => {
  it('无参调用返回与默认配置一致的完整配置', () => {
    const config = defineConfig();
    expect(config.loop.maxTurns).toBe(defaultConfig.loop.maxTurns);
    expect(config.context.layers).toEqual(defaultConfig.context.layers);
  });

  it('深合并：只覆盖指定字段，同域其余字段保持默认', () => {
    const config = defineConfig({ loop: { maxTurns: 32 } });
    expect(config.loop.maxTurns).toBe(32);
    // llm 域未指定 → 完整保留默认
    expect(config.llm).toEqual(defaultConfig.llm);
    // retry 的子字段在「层级覆盖」下保持默认
    const config2 = defineConfig({ llm: { retry: { maxAttempts: 5 } } });
    expect(config2.llm.retry.maxAttempts).toBe(5);
    expect(config2.llm.retry.baseDelayMs).toBe(defaultConfig.llm.retry.baseDelayMs);
  });

  it('undefined 视为「未提供」：不覆盖默认值', () => {
    const config = defineConfig({ loop: { maxTurns: undefined } });
    expect(config.loop.maxTurns).toBe(defaultConfig.loop.maxTurns);
  });

  it('返回配置被深冻结：任何层级的篡改立即抛 TypeError', () => {
    const config = defineConfig();
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.context.layers)).toBe(true);
    // readonly 只是编译期约束，这里模拟「绕过类型系统的运行期篡改」
    const mutableView = config.loop as { maxTurns: number };
    expect(() => {
      mutableView.maxTurns = 999;
    }).toThrow(TypeError);
  });

  it('分层预算合计超过总量 → 构建期抛 config_error', () => {
    expect(() => defineConfig({ context: { layers: { recent: 999_999 } } })).toThrow(HarnessError);
    try {
      defineConfig({ context: { layers: { recent: 999_999 } } });
    } catch (err) {
      expect(err).toBeInstanceOf(HarnessError);
      expect((err as HarnessError).code).toBe('config_error');
    }
  });

  it('maxTurns 非正数 → 构建期抛 config_error', () => {
    expect(() => defineConfig({ loop: { maxTurns: 0 } })).toThrowError(/maxTurns/);
  });

  it('多次调用互相隔离：不同 override 不共享引用', () => {
    const a = defineConfig({ loop: { maxTurns: 1 } });
    const b = defineConfig({ loop: { maxTurns: 2 } });
    expect(a.loop.maxTurns).toBe(1);
    expect(b.loop.maxTurns).toBe(2);
    expect(a.loop).not.toBe(b.loop);
  });
});
