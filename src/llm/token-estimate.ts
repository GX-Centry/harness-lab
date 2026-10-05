/**
 * token 近似计数（全 LLM 层共享的唯一公式）。
 *
 * 为什么抽成独立文件？
 *   FakeProvider 与真实 Provider（openai-compatible）都用同一个近似——
 *   公式只有一份实现，预算是「同增同减」的单调性是全系统统一契约。
 *
 * 教学取舍：ASCII 约 4 字符/token，CJK 约 1.5 字符/token。
 *   公式粗糙但方向正确；预算层（ADR-007）只依赖单调性，
 *   真实精度需要官方 tokenizer（如 tiktoken——原生依赖，谨慎引入）。
 */

/** 估算一段文本的 token 数（ASCII 与 CJK 分开计权） */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && cp < 0x80) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 4 + nonAscii / 1.5);
}
