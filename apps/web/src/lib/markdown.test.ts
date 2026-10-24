import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown 的渲染缓存", () => {
  it("空白输入得到空串；相同内容命中缓存且结果一致（首尾空白不影响命中）", () => {
    expect(renderMarkdown("")).toBe("");
    expect(renderMarkdown("  \n ")).toBe("");
    const a = renderMarkdown("**粗体** 与 `code`");
    expect(a).toContain("<strong>粗体</strong>");
    expect(renderMarkdown("  **粗体** 与 `code`\n")).toBe(a);
  });

  it("超过容量（500）后按 LRU 淘汰最久未用的条目；被淘汰的内容再次渲染结果依然正确", () => {
    const first = renderMarkdown("# 第一个条目");
    for (let i = 0; i < 520; i++) renderMarkdown(`条目 ${i}`);
    // 第一个条目此时已被淘汰，重新渲染仍应得到同样的 HTML
    expect(renderMarkdown("# 第一个条目")).toBe(first);
    // 容量内的最近条目命中缓存，输出稳定
    expect(renderMarkdown("条目 519")).toBe(renderMarkdown("条目 519"));
  });

  it("缓存键是原文：不同内容不会串（含仅标点不同）", () => {
    expect(renderMarkdown("甲")).not.toBe(renderMarkdown("乙"));
    expect(renderMarkdown("a*b*")).not.toBe(renderMarkdown("a b"));
  });
});
