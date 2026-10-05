/**
 * SkillRegistry —— 技能注册表。
 *
 * 这是项目里第三个注册表（ToolRegistry → CommandRegistry → SkillRegistry）。
 * 刻意**不抽公共基类**，理由（教学点——「抽象的成本」）：
 *   三者的校验语义与查询方式各不相同：
 *     - ToolRegistry：校验 schema/风险级别、要产出给模型的声明列表；
 *     - CommandRegistry：名字必须小写（解析协议）、查询做大小写归一；
 *     - SkillRegistry：校验步骤非空（注册即拒绝「空技能」这种无意义数据）。
 *   三处各约 30 行，抽象成泛型基类反而要引入类型体操与「每个子类记得调
 *   super.xxx」的隐性契约。重复成本 < 抽象成本时，选择重复——但保持
 *   各自的行为风格一致（重名抛 config_error、查询返回 undefined）。
 */

import { HarnessError } from '../errors.ts';
import type { SkillDefinition } from './types.ts';

export class SkillRegistry {
  private readonly skills = new Map<string, SkillDefinition>();

  /**
   * 注册技能（幂等失败：重名或空步骤立即抛 config_error）。
   * 与 ToolRegistry 同款哲学：名字是协议的一部分，静默覆盖会制造幽灵行为。
   */
  register(skill: SkillDefinition): this {
    if (this.skills.has(skill.name)) {
      throw new HarnessError('config_error', `技能名重复注册: "${skill.name}"`, {
        where: 'skills/registry',
      });
    }
    if (skill.steps.length === 0) {
      throw new HarnessError('config_error', `技能 "${skill.name}" 没有任何步骤（空技能无意义）`, {
        where: 'skills/registry',
      });
    }
    this.skills.set(skill.name, skill);
    return this;
  }

  /** 按名查找；未找到返回 undefined——「未知技能」的处理权交给 runner（产出结构化失败） */
  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  has(name: string): boolean {
    return this.skills.has(name);
  }

  /** 全部技能（按注册顺序——稳定排序，/skill 列举输出可复现） */
  list(): readonly SkillDefinition[] {
    return [...this.skills.values()];
  }

  get size(): number {
    return this.skills.size;
  }
}
