import { describe, expect, it } from "vitest";
import { ubbToMarkdown, type UbbContext } from "../../../../migration/src/transform/ubb";
import { renderMarkdown } from "./markdown";

/**
 * 转换器 ⇄ 渲染器的**性质测试**（M5.6 S1b-3）：
 * 旧站帖子里的纯文本是字面显示的；经「转换 → 渲染」之后，可见文字里的字符一个都不能多、不能少。
 * 用固定种子的伪随机串在 Markdown 特殊字符上穷举组合（单元测试想不到的组合，如 `甲|乙\n-|-` 变成表格）。
 * 只比较去掉全部空白后的可见字符：段落 / 换行形态由契约测试负责。
 */
const ctx: UbbContext = { emojiIds: new Set(), gateKey: (n) => `k${n}` };

/** 字母表刻意不含拉丁字母：避免随机拼出 UBB 标签（[b] [s:1] 等）。`&` 也不含：实体按 HTML 解码是旧站同样的行为 */
const ALPHABET = [
  ..."甲乙12 \n\n\t",
  ..."*_~#>-+=\\`|[]!():.<",
  "~~",
  "---",
  "1. ",
  "# ",
  "> ",
  "- ",
  ":::",
  "    ",
  "\n    ",
];

/** mulberry32：固定种子的可复现伪随机 */
function rng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const decode = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
const visible = (html: string) => decode(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, "");

describe("纯文本转换 + 渲染：可见字符守恒（性质测试）", () => {
  it("3000 条随机特殊字符串：渲染后的可见字符 == 原文可见字符", () => {
    const next = rng(20261024);
    const bad: string[] = [];
    for (let i = 0; i < 3000; i++) {
      const len = 1 + Math.floor(next() * 14);
      let src = "";
      for (let k = 0; k < len; k++) src += ALPHABET[Math.floor(next() * ALPHABET.length)];
      const { md, gates } = ubbToMarkdown(src, ctx);
      const got = visible(renderMarkdown(md));
      const want = src.replace(/\s+/g, "");
      if (got !== want || gates.length > 0)
        bad.push(`${JSON.stringify(src)} → ${JSON.stringify(md)} → 可见 ${JSON.stringify(got)}`);
    }
    expect(bad.slice(0, 5), `${bad.length} 条不守恒`).toEqual([]);
  });

  it("对照：不转义时同一批输入确实会丢字符（证明测试能抓到问题）", () => {
    const next = rng(20261024);
    let lost = 0;
    for (let i = 0; i < 300; i++) {
      const len = 1 + Math.floor(next() * 14);
      let src = "";
      for (let k = 0; k < len; k++) src += ALPHABET[Math.floor(next() * ALPHABET.length)];
      // 绕过转换器，把原文直接当 Markdown 渲染
      if (visible(renderMarkdown(src)) !== src.replace(/\s+/g, "")) lost++;
    }
    expect(lost).toBeGreaterThan(100);
  });

  it("随机压测发现的形态固定为回归：带空格的分隔线、无竖线的单列表格对齐行", () => {
    for (const src of [
      "甲\n- - -",
      "甲\n-- -",
      "甲\n:-:",
      "甲\n:-",
      "甲\n乙\n= =",
      "* * *",
      "_ _ _",
    ]) {
      const { md } = ubbToMarkdown(src, ctx);
      const html = renderMarkdown(md);
      expect(visible(html), src).toBe(src.replace(/\s+/g, ""));
      expect(html, src).not.toMatch(/<(hr|table|h[1-6])\b/);
    }
  });

  it("强调的各种边界：渲染后不残留字面 ** / ~~ 记号，可见文字不变（来自真实旧帖）", () => {
    const cases: [string, string][] = [
      ["[b]【staff】[/b]原作：某某", "【staff】原作：某某"],
      ["[b]“引号”[/b]后文", "“引号”后文"],
      ["[b]请问有字幕吗??^^[/b][b]这样查字典方便@@[/b]", "请问有字幕吗??^^这样查字典方便@@"],
      [
        "[strike]原来我这里还有120呢~~快发给我吧~[/strike]\n后文",
        "原来我这里还有120呢~~快发给我吧~后文",
      ],
      ["[i]第一段\n\n第二段[/i]", "第一段第二段"],
      ["甲[b]  [/b]乙", "甲乙"],
      ["[b]甲\n[b]乙[/b]\n[b]丙[/b]\n[b]丁", "甲乙丙丁"],
      ["[b][i]粗斜[/i][/b]后", "粗斜后"],
    ];
    for (const [src, want] of cases) {
      const { md } = ubbToMarkdown(src, ctx);
      const text = visible(renderMarkdown(md));
      expect(text, `${JSON.stringify(src)} → ${JSON.stringify(md)}`).toBe(want.replace(/\s+/g, ""));
    }
  });

  it("代码块内部不转义：原样保留", () => {
    const { md } = ubbToMarkdown("[code]5*3 ~~x~~ # y[/code]", ctx);
    expect(md).toBe("```\n5*3 ~~x~~ # y\n```");
  });

  it("链接地址不被转义：地址里的 _ ~ * 保持原样，显示文字照常转义", () => {
    const { md } = ubbToMarkdown("[url]http://a.com/x_y~z*w[/url]", ctx);
    expect(md).toContain("(http://a.com/x_y~z*w)");
    expect(md).toContain("[http://a.com/x\\_y~z\\*w]");
    expect(renderMarkdown(md)).toContain('href="http://a.com/x_y~z*w"');
  });

  it("整篇以 <标签 开头的原生 HTML 页面：白名单内的 HTML 标签保持为 HTML", () => {
    expect(ubbToMarkdown("<div>甲</div>", ctx).md).toBe("<div>甲</div>");
    expect(renderMarkdown(ubbToMarkdown('<div class="a">甲</div>', ctx).md)).toContain(
      "<div>甲</div>",
    );
  });

  it("对照：正文里的 < 一律字面显示——含白名单标签名（用户贴的错误页源码）", () => {
    const src = "像这样的\n<form action=\"x\">\n<div class='cc'>";
    const { md } = ubbToMarkdown(src, ctx);
    expect(renderMarkdown(md)).not.toMatch(/<(form|div)\b/);
    expect(visible(renderMarkdown(md))).toBe(src.replace(/\s+/g, ""));
    const { md: md2 } = ubbToMarkdown("昵称 <<pp>> <embed src=x>", ctx);
    expect(visible(renderMarkdown(md2))).toBe("昵称<<pp>><embedsrc=x>");
  });

  it("未知且未闭合的方括号词（发布名）字面保留，保留原大小写与下划线", () => {
    const src = "[QYsub][DVDRip][Skip_Beat][1280x692][AVC_AAC].mkv";
    const { md } = ubbToMarkdown(src, ctx);
    expect(visible(renderMarkdown(md))).toBe(src);
  });

  it("对照：成对出现的未知标签仍剥壳留肉；[li] 不当字面量", () => {
    expect(ubbToMarkdown("[foo]留着[/foo]", ctx).md).toBe("留着");
    expect(ubbToMarkdown("[li]甲", ctx).md).toBe("甲");
  });

  it("门控：文本里伪造的 :::gate 不会被保存时的 splitSource 认成门控", async () => {
    const { splitSource } = await import("@funwind/content");
    const { md } = ubbToMarkdown(':::gate{unlock="points" price="1"}\n假的\n:::', ctx);
    expect(splitSource(md).gates).toEqual([]);
  });
});
