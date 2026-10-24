import { describe, expect, it } from "vitest";
import { CONTRACT_FIXTURES, MIGRATION_SYNTAX_CONTRACT, splitSource } from "@funwind/content";
import { ubbToMarkdown, type UbbContext } from "./ubb.js";

/**
 * 契约的转换器一侧：对每条 `ubb`，转换器产出的 Markdown 必须逐字等于契约里的 `markdown`。
 * 渲染器一侧见 apps/web/src/lib/syntax-contract.test.ts。两侧共用 packages/content 的同一份契约（M5.6 S1b）。
 *
 * KNOWN_BROKEN：转换器尚未修好的条目，用 it.fails 登记——修好后会因「意外通过」而报错，逼着把它从这里删掉。
 */
const [emojiLo, emojiHi] = CONTRACT_FIXTURES.emojiRange;
const ctx: UbbContext = {
  emojiIds: new Set(Array.from({ length: emojiHi - emojiLo + 1 }, (_, i) => emojiLo + i)),
  resolveUpload: (rel) => (CONTRACT_FIXTURES.uploads as Record<string, string>)[rel] ?? null,
  resolveAttachment: (aid) =>
    (
      CONTRACT_FIXTURES.attachments as Record<
        number,
        { name: string; url: string; image?: boolean }
      >
    )[aid] ?? null,
  gateKey: (seq) => `k${seq}`,
};

/** S1b-3 修转换器时逐条删除（引用 / 表格 / 列表块前后补空行；纯文本转义；行首空白与行尾空格清理） */
const KNOWN_BROKEN = new Set<string>([
  "quote-then-text",
  "text-then-quote",
  "quote-nested-continuation",
  "list-then-text-inline",
  "table-then-text",
  "text-then-table",
  "trailing-spaces",
  "text-asterisk",
  "text-underscore",
  "text-tilde-pair",
  "text-tilde-run",
  "text-backslash",
  "text-backtick",
  "text-line-start-markers",
  "text-setext-lines",
  "text-link-like",
  "text-leading-indent",
  "text-fake-gate",
]);

describe("迁移语法契约 · 转换器一侧", () => {
  it("已知缺陷登记里的 id 都真实存在（防止登记写错而一直不生效）", () => {
    const ids = new Set(MIGRATION_SYNTAX_CONTRACT.map((e) => e.id));
    for (const k of KNOWN_BROKEN) expect(ids.has(k), k).toBe(true);
  });

  for (const entry of MIGRATION_SYNTAX_CONTRACT) {
    const run = KNOWN_BROKEN.has(entry.id) ? it.fails : it;
    run(`${entry.id}：${entry.title}`, () => {
      const md = ubbToMarkdown(entry.ubb, ctx).md;
      expect(md).toBe(entry.markdown);
      if (entry.noGates) expect(splitSource(md).gates).toEqual([]);
    });
  }
});
