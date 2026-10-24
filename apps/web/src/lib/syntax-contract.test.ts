import { describe, expect, it } from "vitest";
import { MIGRATION_SYNTAX_CONTRACT } from "@funwind/content";
import { renderMarkdown } from "./markdown";

/**
 * 契约的渲染器一侧：对每条 `markdown`，渲染结果必须包含 `html` 里的片段、不含 `notInHtml` 里的片段。
 * 转换器一侧见 migration/src/transform/syntax-contract.test.ts（M5.6 S1b）。
 *
 * KNOWN_BROKEN：渲染器尚未修好的条目，用 it.fails 登记——修好后会因「意外通过」而报错，逼着把它从这里删掉。
 */
/** S1b-2 修渲染器时逐条删除（软换行 → <br>；sup / sub 进白名单；CJK 加粗边界） */
const KNOWN_BROKEN = new Set<string>([
  "sup",
  "sub",
  "bold-cjk-punct",
  "quote-multiline",
  "newline-soft",
  "br-tag",
  "trailing-spaces",
]);

describe("迁移语法契约 · 渲染器一侧", () => {
  it("已知缺陷登记里的 id 都真实存在", () => {
    const ids = new Set(MIGRATION_SYNTAX_CONTRACT.map((e) => e.id));
    for (const k of KNOWN_BROKEN) expect(ids.has(k), k).toBe(true);
  });

  for (const entry of MIGRATION_SYNTAX_CONTRACT) {
    const run = KNOWN_BROKEN.has(entry.id) ? it.fails : it;
    run(`${entry.id}：${entry.title}`, () => {
      const html = renderMarkdown(entry.markdown);
      for (const frag of entry.html) expect(html, `应包含 ${JSON.stringify(frag)}`).toContain(frag);
      for (const frag of entry.notInHtml ?? [])
        expect(html, `不应包含 ${JSON.stringify(frag)}`).not.toContain(frag);
    });
  }
});
