import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 迁移报告构建器：输出确定性的 Markdown（不含运行时间戳），
 * 因此「连跑两次得到逐字节相同的报告」本身就是幂等性证据，报告也适合入库评审。
 */
export class Report {
  private readonly parts: string[] = [];

  constructor(
    private readonly title: string,
    intro: string[] = [],
  ) {
    this.parts.push(`# ${title}`, "", ...intro, ...(intro.length ? [""] : []));
  }

  section(title: string): Section {
    this.parts.push(`## ${title}`, "");
    return new Section(this.parts);
  }

  toMarkdown(): string {
    return (
      this.parts
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trimEnd() + "\n"
    );
  }

  save(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, this.toMarkdown(), "utf8");
  }
}

const cell = (v: unknown) =>
  String(v ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ");

export class Section {
  constructor(private readonly parts: string[]) {}

  line(text: string): this {
    this.parts.push(text, "");
    return this;
  }

  bullets(items: readonly string[]): this {
    if (items.length === 0) return this;
    this.parts.push(...items.map((x) => `- ${x}`), "");
    return this;
  }

  /** 表格；rows 为空时输出「无」 */
  table(headers: readonly string[], rows: readonly (readonly unknown[])[]): this {
    if (rows.length === 0) {
      this.parts.push("（无）", "");
      return this;
    }
    this.parts.push(
      `| ${headers.map(cell).join(" | ")} |`,
      `| ${headers.map(() => "---").join(" | ")} |`,
      ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
      "",
    );
    return this;
  }
}
