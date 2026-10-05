// ============================================================
// Vitest 配置
// 设计决策：
//  - pool 用 'forks'：在 Windows 上比 worker threads 更稳（线程池与
//    node:sqlite 句柄、文件锁的交互更可预测），教学项目优先「确定性」。
//  - 测试分为三层（见 docs/03-module-guide.md 的测试策略一节）：
//      unit/          纯单元（不触网、不落盘）
//      integration/   模块组装（FakeProvider 驱动）
//      scenarios/     端到端确定性场景（对齐 agent-api-lab 方法论）
// ============================================================
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 15_000,
    hookTimeout: 15_000,
    reporters: ['default'],
  },
});
