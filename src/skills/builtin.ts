/**
 * 内置演示技能 —— 一个清晰的「步骤间数据流」样本。
 *
 * 演示目标：让读者在一次执行中看到技能的全部关键机制：
 *   ① 声明与执行分离（本文件只有数据，没有执行逻辑）；
 *   ② 数据流：第 2 步消费第 1 步的输出；
 *   ③ 与 Dispatcher 的完整接力（工具事件嵌在技能事件里，见 lab 幕 F 输出）。
 *
 * 生产形态说明（演进路径）：
 *   真实项目里技能库通常从外部加载（Markdown/YAML 描述 + 少量胶水代码），
 *   本文件只是「代码内联注册」的最小样本。技能数量增长后考虑：
 *   skills/loader.ts（文件系统加载器）→ 产出 SkillDefinition[] 集合。
 */

import type { SkillDefinition } from './types.ts';

// ---------------------------------------------------------------------------
// math-report：计算四则表达式 → 生成可读报告
// ---------------------------------------------------------------------------

/**
 * 两步流水线：calculator（计算）→ echo（格式化输出）。
 *
 * 输入约定（input.text）：
 *   - /skill 命令执行时把命令剩余参数作为 text 透传（如 `/skill math-report 21 * 2`）；
 *   - 代码调用可直接传 { text: "..." }；缺省回退到 "1 + 1"（保证技能永远可跑）。
 *
 * 为什么用 echo 作为第 2 步？
 *   它是零副作用的确定性工具——把「数据流的消费端」演示清楚而不引入
 *   文件 IO/网络等干扰变量。真实技能的第 2 步通常是 fs_write 落盘或
 *   调用外部 API 这类有副作用的动作（会经由同一四步链接受权限控制）。
 */
export const mathReportSkill: SkillDefinition = {
  name: 'math-report',
  description: '计算一个四则表达式，再生成一段可读报告（calculator → echo 两步流水线）',
  steps: [
    {
      tool: 'calculator',
      describe: '计算表达式（取 input.text，缺省 "1 + 1"）',
      resolveArgs: (ctx) => {
        const text = ctx.input['text'];
        const expression = typeof text === 'string' && text.trim() !== '' ? text : '1 + 1';
        return { expression };
      },
    },
    {
      tool: 'echo',
      describe: '把第 1 步的计算结果包装成报告文本',
      resolveArgs: (ctx) => {
        // 数据流演示点：从「前序结果」取第 1 步的输出（文本通道）
        const calc = ctx.results[0];
        const body = calc?.output ?? '（无计算结果：第 1 步未产出）';
        return { message: `【计算报告】${body}` };
      },
    },
  ],
};

/** 返回全部内置技能的工厂（与 createBuiltinTools 同款约定） */
export function createBuiltinSkills(): SkillDefinition[] {
  return [mathReportSkill];
}
