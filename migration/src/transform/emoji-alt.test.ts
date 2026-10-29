import { describe, expect, it } from "vitest";
import { codeRanges, rewriteEmojiAlt, type EmojiMeta } from "./emoji-alt.js";

/** emojis 表的形态（演练库与开发库一致）：120–169 为 gif、迁移导入名占位；171 是后台上传的 png */
const NAMES = new Map<number, EmojiMeta>([
  [120, { id: 120, ext: "gif", name: "茉莉 01 哈哈" }],
  [121, { id: 121, ext: "gif", name: "旧表情 121" }],
  [171, { id: 171, ext: "png", name: "新表情" }],
]);

describe("rewriteEmojiAlt", () => {
  it("alt 改写为当前名称；行内 / 行中 / 转义波浪线前缀等位置变体都命中", () => {
    const src = [
      "开头 ![表情](/emoji/120.gif) 行中",
      "~![表情](/emoji/120.gif) 转义波浪线",
      "![表情](/emoji/120.gif)独占行首",
    ].join("\n");
    const r = rewriteEmojiAlt(src, NAMES);
    expect(r.changed).toBe(3);
    expect(r.orphans).toEqual([]);
    expect(r.md).not.toContain("![表情]");
    expect(r.md.match(/!\[茉莉 01 哈哈\]\(\/emoji\/120\.gif\)/g)).toHaveLength(3);
  });

  it("幂等：alt 已等于当前名称的跳过（changed=0、alreadyCurrent 计数）", () => {
    const src = "![茉莉 01 哈哈](/emoji/120.gif) 不动 ![表情](/emoji/120.gif) 改";
    const r = rewriteEmojiAlt(src, NAMES);
    expect(r.changed).toBe(1);
    expect(r.alreadyCurrent).toBe(1);
    expect(r.md).toBe("![茉莉 01 哈哈](/emoji/120.gif) 不动 ![茉莉 01 哈哈](/emoji/120.gif) 改");
  });

  it("孤儿引用只报告不改写：id 不存在、ext 与库内不一致；合法引用照常改写", () => {
    const src = "![x](/emoji/999.gif) ![y](/emoji/120.png) ![旧名](/emoji/171.png)";
    const r = rewriteEmojiAlt(src, NAMES);
    expect(r.changed).toBe(1); // 只有 171 是合法的
    expect(r.orphans).toEqual(["/emoji/999.gif", "/emoji/120.png"]);
    expect(r.md).toBe("![x](/emoji/999.gif) ![y](/emoji/120.png) ![新表情](/emoji/171.png)");
  });

  it("代码保护：围栏代码块与行内 code span 里的示例文本不碰（既不改也不报孤儿）", () => {
    const src = [
      "正文 ![表情](/emoji/120.gif) 尾",
      "", // 围栏
      "```md",
      "示例 ![表情](/emoji/120.gif) 与孤儿 ![x](/emoji/999.gif)",
      "```",
      "再写个行内示例 `![表情](/emoji/120.gif)` 结束",
    ].join("\n");
    const r = rewriteEmojiAlt(src, NAMES);
    expect(r.changed).toBe(1); // 只有正文那一处
    expect(r.orphans).toEqual([]); // 围栏里的孤儿不算
    expect(r.md).toContain("示例 ![表情](/emoji/120.gif) 与孤儿 ![x](/emoji/999.gif)");
    expect(r.md).toContain("`![表情](/emoji/120.gif)`");
  });

  it("空 alt 与含中文的旧 alt 都能改写；无关图片语法不受影响", () => {
    const src = "![](/emoji/121.gif) ![旧名](/emoji/171.png) ![外站](https://x/y.png)";
    const r = rewriteEmojiAlt(src, NAMES);
    expect(r.changed).toBe(2);
    expect(r.md).toBe(
      "![旧表情 121](/emoji/121.gif) ![新表情](/emoji/171.png) ![外站](https://x/y.png)",
    );
  });

  it("codeRanges：多行围栏与行内 span；双反引号 span 不在保护范围（漏改优于改坏）", () => {
    const md = "a `x y` b\n```\ncode\n```\ntail `z` end";
    expect(codeRanges(md)).toHaveLength(3);
  });

  it("转义反引号（\\`）是字面字符，不构成 code span：其中的表情语法照常改写（3 帖实测教训）", () => {
    const src = String.raw`来做吧 \`\`\`![表情](/emoji/120.gif)嘿嘿\`\`\``;
    const r = rewriteEmojiAlt(src, NAMES);
    expect(r.changed).toBe(1);
    expect(r.md).toBe(String.raw`来做吧 \`\`\`![茉莉 01 哈哈](/emoji/120.gif)嘿嘿\`\`\``);
    // 对照：非转义反引号之间的示例仍然被保护
    const guarded = "a `![表情](/emoji/120.gif)` b";
    expect(rewriteEmojiAlt(guarded, NAMES).changed).toBe(0);
  });
});
