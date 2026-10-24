import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Report } from "./report.js";

describe("Report", () => {
  const build = () => {
    const r = new Report("标题", ["说明一", "说明二"]);
    const s = r.section("小节");
    s.line("正文").bullets(["甲", "乙"]).bullets([]);
    s.table(
      ["a", "b"],
      [
        [1, "x|y"],
        [2, null],
      ],
    );
    s.table(["a"], []);
    return r;
  };

  it("输出结构：标题、说明、小节、列表、表格（管道符转义，空表输出「无」）", () => {
    const md = build().toMarkdown();
    expect(md).toContain("# 标题");
    expect(md).toContain("## 小节");
    expect(md).toContain("- 甲\n- 乙");
    expect(md).toContain("| a | b |\n| --- | --- |\n| 1 | x\\|y |\n| 2 |  |");
    expect(md).toContain("（无）");
    expect(md.endsWith("\n")).toBe(true);
    expect(md).not.toMatch(/\n{3,}/);
  });

  it("确定性：相同输入逐字节相同（可作为幂等性证据）", () => {
    expect(build().toMarkdown()).toBe(build().toMarkdown());
  });

  it("保存时自动创建目录", () => {
    const dir = mkdtempSync(join(tmpdir(), "report-"));
    const file = join(dir, "a", "b", "r.md");
    build().save(file);
    expect(readFileSync(file, "utf8")).toBe(build().toMarkdown());
  });
});
