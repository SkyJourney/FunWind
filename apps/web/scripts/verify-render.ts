#!/usr/bin/env node
/**
 * verify:render —— 迁移库全部正文用**真实渲染器**渲染一遍，检测「渲染结果的形状与意图不符」（M5.6 S1b，本地硬门禁）。
 *
 * 为什么存在：转换器与渲染器各有测试，但没人测两边接得上。S1 暴露渲染器不解析表格 / 删除线，S1b 的数据分析又发现
 * 软换行塌陷、引用 / 表格 / 列表后的文字被吞。契约测试（packages/content/src/syntax-contract.ts）守住构造层面，
 * 这个脚本守住**真实数据**层面：它需要迁移库，所以不进 CI，挂在本地 `pnpm verify:migration`。
 *
 * 棘轮：每个探测器有一个允许上限（ALLOWED），当前值只许降不许升；降到 0 就是目标。脚本发现实际值低于上限时会提示收紧。
 * 注意：这里读取了门控隐藏正文（hidden_md）——只是离线质检脚本，输出只含 id 与计数，不含正文；站点运行时代码仍只能经 lib/gates/service.ts 读取（硬约定 3b）。
 */
import { splitByGatePlaceholders } from "@funwind/content";
import { postGates, posts, withDb } from "@funwind/db";
import { renderMarkdown } from "../src/lib/markdown";

/** 探测器：返回 true 表示该文档命中缺陷 */
const DETECTORS: Record<
  string,
  { allowed: number; why: string; hit: (md: string, html: string) => boolean }
> = {
  quoteLazy: {
    allowed: 2168,
    why: "引用后紧跟的非引用行被 Markdown 的懒续行吞进引用（转换器缺空行）",
    hit: (md) => /^>[^\n]*\n(?!>|\s*$)/m.test(withoutFences(md)),
  },
  tableSwallow: {
    allowed: 4,
    why: "表格后紧跟的文字被当成表格的一行（转换器缺空行）",
    hit: (md) => /^\|[^\n]*\|[ \t]*\n(?!\||\s*$)/m.test(withoutFences(md)),
  },
  listSwallow: {
    allowed: 1,
    why: "列表后紧跟的文字被吞进最后一个列表项（转换器缺空行）",
    hit: (md) => /^- [^\n]*\n(?!- |\s*$|\s{2,})/m.test(withoutFences(md)),
  },
  softBreakCollapsed: {
    allowed: 0,
    why: "段落里的单个换行没有变成 <br>，浏览器里塌成空格（渲染器缺 remark-breaks）。正文含原生 HTML 块（<div> / <p> / <table>）的帖子排除：HTML 里的换行本来就按空白折叠，与旧站显示一致（迁移库 7 篇，post:42268–42275）",
    hit: (md, html) =>
      !/<(div|p|table)\b/i.test(md) &&
      /<p>[^<]*\n[^<]*/.test(html.replace(/<(pre|blockquote)[\s\S]*?<\/\1>/g, "")),
  },
};

const withoutFences = (md: string) => md.replace(/^```[\s\S]*?^```/gm, "");

async function main() {
  const { docs, gateDocs } = await withDb(async ({ db }) => {
    const a = await db.select({ id: posts.id, md: posts.bodyMd }).from(posts);
    const b = await db.select({ id: postGates.id, md: postGates.hiddenMd }).from(postGates);
    return {
      docs: a
        .filter((r) => r.md && r.md.trim() !== "")
        .map((r) => ({ k: `post:${r.id}`, md: String(r.md) })),
      gateDocs: b.filter((r) => r.md.trim() !== "").map((r) => ({ k: `gate:${r.id}`, md: r.md })),
    };
  });

  const hits: Record<string, string[]> = Object.fromEntries(
    Object.keys(DETECTORS).map((k) => [k, []]),
  );
  let renderErrors = 0;
  for (const d of [...docs, ...gateDocs]) {
    // 帖子正文里门控以占位出现，PostBody 先按占位切分再渲染；这里同样只渲染 md 段
    const segments = d.k.startsWith("post:")
      ? splitByGatePlaceholders(d.md).flatMap((s) => (s.kind === "md" ? [s.text] : []))
      : [d.md];
    const flagged = new Set<string>();
    for (const seg of segments) {
      if (seg.trim() === "") continue;
      let html: string;
      try {
        html = renderMarkdown(seg);
      } catch {
        renderErrors++;
        continue;
      }
      for (const [name, det] of Object.entries(DETECTORS))
        if (det.hit(seg, html)) flagged.add(name);
    }
    for (const name of flagged) hits[name]!.push(d.k);
  }

  console.log(
    `\n========== verify:render（${docs.length} 篇正文 + ${gateDocs.length} 段门控隐藏正文）==========`,
  );
  let fail = 0;
  for (const [name, det] of Object.entries(DETECTORS)) {
    const n = hits[name]!.length;
    const over = n > det.allowed;
    if (over) fail++;
    const note = over
      ? `✘ 超出上限 ${det.allowed}`
      : n < det.allowed
        ? `✔（可把上限收紧到 ${n}）`
        : n === 0
          ? "✔"
          : `✔（等于上限 ${det.allowed}）`;
    console.log(
      `${String(n).padStart(6)}  ${name.padEnd(20)} ${note}\n        ${det.why}${n ? `\n        例: ${hits[name]!.slice(0, 8).join(", ")}` : ""}`,
    );
  }
  console.log(
    `${String(renderErrors).padStart(6)}  renderErrors         ${renderErrors === 0 ? "✔" : "✘ 渲染抛错"}`,
  );
  if (renderErrors > 0) fail++;
  console.log("====================================================");
  console.log(fail === 0 ? "全部通过" : `失败 ${fail} 项`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
