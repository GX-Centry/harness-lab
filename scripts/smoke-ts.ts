// ============================================================
// 冒烟脚本：验证 Node 26 原生运行 TypeScript 的能力（type-stripping）。
// 为什么重要：
//   tsconfig 已开启 `erasableSyntaxOnly`，全仓库只使用可擦除类型语法。
//   如果 Node 原生即可直接运行 .ts，开发期可以完全不用转译器；
//   tsx 则作为兜底方案（package.json scripts 中默认用 tsx）。
// 运行：node scripts/smoke-ts.ts
// ============================================================

const label: string = 'native-ts-ok';
const meta = {
  label,
  node: process.version,
  mode: 'type-stripping',
  platform: `${process.platform}/${process.arch}`,
} as const;

console.log(JSON.stringify(meta));
