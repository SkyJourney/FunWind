import { ubbToMarkdown } from "./ubb.js";

/** 门控占位块（key 形态） */
const GATE_PLACEHOLDER = /\n*:::gate\{key="[\w-]+"\}\n:::\n*/g;

/**
 * 签名等不允许出现门控的文本转换器：转换后丢弃门控占位，隐藏内容随之丢弃（绝不并入公开文本）。
 */
export function plainConverter(emojiIds: ReadonlySet<number>): (ubb: string) => string {
  return (ubb) => ubbToMarkdown(ubb, { emojiIds }).md.replace(GATE_PLACEHOLDER, "\n").trim();
}
