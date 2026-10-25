/**
 * @提及解析（M8）：从正文里提取 `@用户名` 候选。
 *
 * 规则（保守优先，宁可少报不误报）：
 *  · `@` 必须出现在行首，或前一个字符是空白——`aⓐb.com` 之类的邮箱形态（@ 夹在词中）不算；
 *  · 用户名 token：@ 后的连续非空白字符，遇到全角标点/结束类符号即截断，最长 32；
 *  · 什么都不保证命中真实用户——解析只给候选，精确匹配归一化键由调用方（web 层）完成；
 *  · 门控隐藏区、代码块不做特殊处理——调用方传入的是「公开正文」（body_md），隐藏区天然不在其中。
 */

/** token 截断字符：空白、常见的全角/半角结束标点（含 CJK 括号引号） */
const TOKEN_STOP = /[\s，。；：、！？（）【】《》「」『』"'"'@!?.,;:\])>~]/u;

/** 允许 @ 出现的前置边界：行首、空白、开括号/引号，以及全角逗号句号（中文多提及分隔的自然写法） */
const PREV_OK = /[\s，。、；：（【《「『"'(\[]/u;

export interface MentionSpan {
  /** @ 后的用户名候选（未归一化） */
  token: string;
  start: number;
  end: number;
}

export function extractMentionSpans(source: string): MentionSpan[] {
  const spans: MentionSpan[] = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== "@") continue;
    // 前一个字符必须是行首或空白（email 等场景的 @ 不算提及）
    const prev = i > 0 ? source[i - 1] : "";
    if (prev !== "" && !PREV_OK.test(prev)) continue;
    let end = i + 1;
    while (end < source.length && end - i <= 32 && !TOKEN_STOP.test(source[end]!)) {
      end++;
    }
    const token = source.slice(i + 1, end);
    if (token.length === 0) continue;
    spans.push({ token, start: i, end });
    i = end - 1; // 跳过已消费的 token
  }
  return spans;
}

/** 提取提及候选（去重，保序） */
export function extractMentionTokens(source: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of extractMentionSpans(source)) {
    if (!seen.has(s.token)) {
      seen.add(s.token);
      out.push(s.token);
    }
  }
  return out;
}
