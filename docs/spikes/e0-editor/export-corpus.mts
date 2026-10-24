import { readFileSync, writeFileSync } from "node:fs";
import mysql from "mysql2/promise";
import { assembleSource } from "/Volumes/Projects/FunWind/packages/content/src/index.ts";

const env = Object.fromEntries(
  readFileSync("/Volumes/Projects/FunWind/.env", "utf8")
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, "")];
    }),
);
const mask = (s: string) =>
  s
    .replace(/[\w.+-]+\u0040[\w-]+\.[\w.-]+/g, "user@example.com")
    .replace(/\b1[3-9]\d{9}\b/g, "13800000000");
const c = await mysql.createConnection({
  host: env.NEW_DB_HOST ?? "127.0.0.1",
  port: Number(env.NEW_DB_PORT ?? 33621),
  user: env.NEW_DB_USER ?? "root",
  password: env.NEW_DB_PASSWORD,
  database: "qysub_next",
});

type Item = { id: string; kind: string; source: string };
const items: Item[] = [];

// 1) 手工结构用例
const synth: [string, string][] = [
  [
    "标题与段落",
    "# 一级\n\n## 二级\n\n正文**加粗**和*斜体*和`行内代码`。\n\n第二段，含 emoji 😀🎉 与中文标点：“引号”。",
  ],
  ["列表嵌套", "- 一\n  - 二\n    - 三\n- 四\n\n1. 甲\n2. 乙\n   1. 乙一\n3. 丙"],
  ["引用嵌套", "> 一级引用\n>\n> > 二级引用\n>\n> 回到一级"],
  ["代码围栏", "```ts\nconst a = 1;\nconsole.log(`模板 ${a}`);\n```\n\n行内 `x < y && y > z`。"],
  ["表格", "| 名称 | 数量 |\n| --- | ---: |\n| 苹果 | 3 |\n| 梨 | 5 |"],
  ["删除线与波浪线", "~~已划掉~~，语气词~我也是~好在，更新到第1~12集。"],
  [
    "分割线与图片链接",
    "上文\n\n---\n\n下文 ![图](/files/ab/cd/x.png) 与 [链接](https://example.com/a?b=1&c=2)。表情 ![表情](/emoji/130.gif)",
  ],
  [
    "内嵌 HTML",
    '文字<sup>上标</sup>和<sub>下标</sub>和<u>下划线</u>，<span style="color:#cb4042">红字</span>。\n\n<div align="center">居中</div>',
  ],
  [
    "转义与特殊字符",
    "星号 \\*不是强调\\*，下划线 snake_case_name，井号 \\# 不是标题，竖线 a \\| b，反引号 \\`。",
  ],
  [
    "门控-积分",
    '公开部分。\n\n:::gate{key="a1" unlock="points" price="50"}\n付费可见的 **Markdown**，含列表：\n\n- 一\n- 二\n\n```js\nlet x = 1;\n```\n:::\n\n后文。',
  ],
  ["门控-回复可见", '前文\n\n:::gate{key="b2" unlock="reply"}\n回复后可见\n:::\n'],
  [
    "门控-多个与 any",
    ':::gate{key="g1" unlock="points" price="10" match="any"}\n甲\n:::\n\n中间文字\n\n:::gate{key="g2" unlock="reply"}\n乙\n:::',
  ],
  [
    "门控-内含指令需加长围栏",
    '::::gate{key="c3" unlock="points" price="5"}\n内部有 :::poll 之类的块：\n\n:::poll\n选项\n:::\n::::',
  ],
  [
    "门控-内含表格与引用",
    ':::gate{key="d4" unlock="points" price="0"}\n| a | b |\n| - | - |\n| 1 | 2 |\n\n> 引用\n:::',
  ],
  [
    "中文长段落",
    "字幕组发布规范：".repeat(1) +
      "第一，所有时间轴以毫秒为单位校对；第二，术语表统一使用最新版本；第三，成品需经两人交叉审校后方可发布。".repeat(
        8,
      ),
  ],
];
for (const [name, source] of synth) items.push({ id: `synth:${name}`, kind: "synthetic", source });

// 2) 真实帖：全部表格帖 + 随机 130 + 含删除线 20 + 含引用 20
const [tbl] = (await c.query(
  "SELECT id, body_md FROM posts WHERE has_gate = 0 AND body_md REGEXP '\\\\|[ -]*-{3,}[ -]*\\\\|' ORDER BY id",
)) as any;
const [rnd] = (await c.query(
  "SELECT id, body_md FROM posts WHERE has_gate = 0 AND body_md IS NOT NULL AND CHAR_LENGTH(body_md) BETWEEN 20 AND 6000 ORDER BY RAND(42) LIMIT 130",
)) as any;
const [stk] = (await c.query(
  "SELECT id, body_md FROM posts WHERE has_gate = 0 AND body_md REGEXP '~~[^~[:space:]][^~]*~~' ORDER BY RAND(7) LIMIT 20",
)) as any;
const [qte] = (await c.query(
  "SELECT id, body_md FROM posts WHERE has_gate = 0 AND body_md LIKE '>%' AND CHAR_LENGTH(body_md) < 4000 ORDER BY RAND(9) LIMIT 20",
)) as any;
const seen = new Set<number>();
for (const [kind, rows] of [
  ["real-table", tbl],
  ["real-random", rnd],
  ["real-strike", stk],
  ["real-quote", qte],
] as const)
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    items.push({ id: `post:${r.id}`, kind, source: mask(String(r.body_md)) });
  }

// 3) 真实带门控帖：还原成「完整源码」（编辑旧帖时编辑器真正拿到的形态）
const [gp] = (await c.query(
  "SELECT id, body_md FROM posts WHERE has_gate = 1 ORDER BY RAND(5) LIMIT 40",
)) as any;
for (const p of gp) {
  const [gs] = (await c.query(
    "SELECT gate_key, conditions, match_mode, hidden_md FROM post_gates WHERE post_id = ? ORDER BY id",
    [p.id],
  )) as any;
  const drafts = gs.map((g: any, i: number) => ({
    key: g.gate_key,
    seq: i + 1,
    conditions: typeof g.conditions === "string" ? JSON.parse(g.conditions) : g.conditions,
    matchMode: g.match_mode,
    hiddenMd: mask(String(g.hidden_md)),
  }));
  const r = assembleSource(mask(String(p.body_md)), drafts);
  if (r.errors.length === 0)
    items.push({ id: `gated-post:${p.id}`, kind: "real-gated", source: r.source });
}
await c.end();
writeFileSync(new URL("./public/corpus.json", import.meta.url), JSON.stringify(items));
const by: Record<string, number> = {};
for (const i of items) by[i.kind] = (by[i.kind] ?? 0) + 1;
console.log("语料条数", items.length, JSON.stringify(by));
