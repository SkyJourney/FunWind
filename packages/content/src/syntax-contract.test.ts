import { describe, expect, it } from "vitest";
import { MIGRATION_SYNTAX_CONTRACT } from "./syntax-contract.js";

describe("迁移语法契约自身的完整性", () => {
  it("id 唯一、说明与样例都不为空", () => {
    const ids = MIGRATION_SYNTAX_CONTRACT.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of MIGRATION_SYNTAX_CONTRACT) {
      expect(e.title, e.id).not.toBe("");
      expect(e.ubb, e.id).not.toBe("");
      expect(e.markdown, e.id).not.toBe("");
      expect(e.markdown, `${e.id}：markdown 必须已 trim`).toBe(e.markdown.trim());
      expect(
        e.html.length + (e.notInHtml?.length ?? 0),
        `${e.id}：至少要有一条 HTML 断言`,
      ).toBeGreaterThan(0);
    }
  });

  it("覆盖了转换器会产出的主要构造（防止契约被悄悄删空）", () => {
    const ids = new Set(MIGRATION_SYNTAX_CONTRACT.map((e) => e.id));
    for (const must of [
      "bold",
      "italic",
      "strike-s",
      "quote",
      "quote-then-text",
      "list",
      "table",
      "table-then-text",
      "newline-soft",
      "text-asterisk",
      "text-tilde-pair",
      "text-line-start-markers",
      "text-fake-gate",
    ]) {
      expect(ids.has(must), must).toBe(true);
    }
    expect(MIGRATION_SYNTAX_CONTRACT.length).toBeGreaterThanOrEqual(45);
  });
});
