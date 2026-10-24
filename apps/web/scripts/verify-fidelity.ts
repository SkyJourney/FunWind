#!/usr/bin/env node
/**
 * verify:fidelity —— 旧站原文 → 转换器 → 真实渲染器，检查「Markdown 特殊字符守恒」（M5.6 S1b，本地硬门禁）。
 *
 * 要回答的问题：旧站 HTML 里用户打的 `* _ ~ # > - = \ ` | [ ] ! ( ) + <` 是字面显示的；经过我们的转换与渲染后，
 * 可见文字里这些字符的个数不应变少。变少 = 被 Markdown 吃掉了（如 `5*3=15` 变斜体、`~~哼哼~~` 变删除线、行首的 `#` 变标题）。
 * 不比较整段文字：图片、附件、站内链接改写会造成大量误报；只数特殊字符，稳而准。
 *
 * 需要**旧库**（只读 SELECT）与转换器，所以只能本地跑，挂在 `pnpm verify:migration`。
 * 棘轮：ALLOWED 当前值只许降不许升，目标 0。输出只含帖子 id 与计数。
 */
import { closePools } from "../../../migration/src/db";
import { extractPosts, extractThreads } from "../../../migration/src/extract";
import { ubbToMarkdown } from "../../../migration/src/transform/ubb";
import { renderMarkdown } from "../src/lib/markdown";

/** 允许「被吃掉特殊字符」的文档数上限（棘轮，目标 0）；按字符分项，便于看清修复进度 */
const ALLOWED_TOTAL = 1901;
const SPECIALS = "*_~#>-=\\`|[]!()+<";

const ctx = {
  emojiIds: new Set(Array.from({ length: 50 }, (_, i) => 120 + i)),
  resolveUpload: () => null,
  resolveAttachment: () => null,
  gateKey: (n: number) => `k${n}`,
};

const decode = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ");

/** 旧站原文里「应当显示出来」的字符：去掉标签；图片 / 附件 / 媒体整段去掉（其内容是网址）；链接只留文字 */
function sourceVisible(ubb: string): string {
  return decode(
    ubb
      .replace(/\[(sell|post|hide)[^\]]*\][\s\S]*?\[\/\1\]/gi, "")
      .replace(
        /\[(img|attachment|flash|media|video|audio|mp3|wmv|rm|swf)(=[^\]]*)?\][\s\S]*?\[\/\1\]/gi,
        "",
      )
      .replace(/\[attachment=\d+\]/gi, "")
      .replace(/\[s:\d+\]/g, "")
      .replace(/\[(url|email)(=[^\]]*)?\]([\s\S]*?)\[\/\1\]/gi, "$3")
      .replace(/\[\/?[a-zA-Z*]+(=[^\]]*)?\]/g, ""),
  );
}
const htmlVisible = (html: string) => decode(html.replace(/<[^>]+>/g, ""));

const counts = (s: string) => {
  const m = new Map<string, number>();
  for (const c of s) if (SPECIALS.includes(c)) m.set(c, (m.get(c) ?? 0) + 1);
  return m;
};

/** 本检查无法判定的文档（转换器会改写其中的链接 / HTML、或含门控），排除以免误报 */
const excluded = (ubb: string) =>
  /\[(sell|post|hide)\b/i.test(ubb) ||
  /job\.php\?action=topost|read\.php\?/i.test(ubb) ||
  /<(img|a)\s/i.test(ubb);

async function main() {
  const threads = (await extractThreads()).filter(
    (t) => !Number(t.disabled) && !Number(t.ifshield),
  );
  const posts = (await extractPosts()).filter((p) => !Number(p.disabled) && !Number(p.ifshield));
  await closePools();

  const docs = [
    ...threads.flatMap((t) =>
      t.content ? [{ k: `thread:${t.tid}`, ubb: String(t.content) }] : [],
    ),
    ...posts.flatMap((p) => (p.content ? [{ k: `post:${p.pid}`, ubb: String(p.content) }] : [])),
  ];

  const byChar = new Map<string, string[]>();
  let compared = 0;
  let eaten = 0;
  for (const d of docs) {
    if (excluded(d.ubb)) continue;
    compared++;
    const src = counts(sourceVisible(d.ubb));
    const out = counts(htmlVisible(renderMarkdown(ubbToMarkdown(d.ubb, ctx).md)));
    let bad = false;
    for (const [c, n] of src) {
      if ((out.get(c) ?? 0) < n) {
        bad = true;
        (byChar.get(c) ?? byChar.set(c, []).get(c)!).push(d.k);
      }
    }
    if (bad) eaten++;
  }

  console.log(
    `\n========== verify:fidelity（旧库 ${docs.length} 篇，纳入比较 ${compared} 篇）==========`,
  );
  for (const [c, ids] of [...byChar].sort((a, b) => b[1].length - a[1].length))
    console.log(
      `${String(ids.length).padStart(6)}  被吃掉的 ${JSON.stringify(c)}   例: ${ids.slice(0, 3).join(", ")}`,
    );
  const over = eaten > ALLOWED_TOTAL;
  console.log(
    `${String(eaten).padStart(6)}  特殊字符被吃掉的文档数（上限 ${ALLOWED_TOTAL}） ${over ? "✘ 超出" : eaten < ALLOWED_TOTAL ? `✔（可把上限收紧到 ${eaten}）` : eaten === 0 ? "✔" : "✔（等于上限）"}`,
  );
  console.log("====================================================");
  process.exitCode = over ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
