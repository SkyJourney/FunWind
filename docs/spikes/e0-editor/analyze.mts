import { readFileSync } from "node:fs";
const corpus: any[] = JSON.parse(readFileSync("public/corpus.json", "utf8"));
const byId = new Map(corpus.map((c) => [c.id, c]));
const name = process.argv[2]!;
const rows: any[] = JSON.parse(readFileSync(`batch-${name}.json`, "utf8"))[name];
const cat = (src: string, out: string): string => {
  const a = src.trim().split("\n"),
    b = out.trim().split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    if (a[i] !== b[i]) {
      const x = a[i] ?? "",
        y = b[i] ?? "";
      if (/~/.test(x) && !/~/.test(y)) return "波浪线被改（删除线）";
      if (/<(sup|sub|u|span|div|font)/i.test(x) && !/<(sup|sub|u|span|div)/i.test(y))
        return "内嵌 HTML 被剥掉";
      if (/^\s*\|/.test(x)) return "表格行变化";
      if (/!\[/.test(x) && !/!\[/.test(y)) return "图片丢失";
      if (/^\s*>/.test(x)) return "引用变化";
      if (/:::gate|^:::/.test(x) || /:::gate/.test(y)) return "门控围栏变化";
      if (/\\/.test(y) && !/\\/.test(x)) return "新增转义反斜杠";
      if (/^\s*[-*+]\s/.test(x) || /^\s*\d+\.\s/.test(x)) return "列表标记变化";
      if (/https?:\/\//.test(x)) return "URL/链接变化";
      return "其他";
    }
  return "(无逐行差异)";
};
const bad = rows.filter((r) => !r.equiv);
const groups = new Map<string, { n: number; ex: string[] }>();
for (const r of bad) {
  const src = byId.get(r.id).source;
  const k = r.error ? "报错: " + r.error.replace(/\s+/g, " ").slice(0, 60) : cat(src, r.out ?? "");
  const g = groups.get(k) ?? { n: 0, ex: [] };
  g.n++;
  if (g.ex.length < 2) {
    const a = src.trim().split("\n"),
      b = (r.out ?? "").trim().split("\n");
    let line = "";
    for (let i = 0; i < Math.max(a.length, b.length); i++)
      if (a[i] !== b[i]) {
        line = `${r.id}\n      原: ${(a[i] ?? "").slice(0, 90)}\n      后: ${(b[i] ?? "").slice(0, 90)}`;
        break;
      }
    g.ex.push(line || r.id);
  }
  groups.set(k, g);
}
console.log(`## ${name}：不等价 ${bad.length} 条，按首个差异归类`);
for (const [k, g] of [...groups].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`- ${k}: ${g.n}`);
  for (const e of g.ex) console.log("    " + e);
}
