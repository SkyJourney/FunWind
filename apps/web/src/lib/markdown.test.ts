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

/**
 * 软换行 → <br>（M5.6 S1b-2）。迁移库约 27% 的帖子在段内有单个换行，旧站里换行就是换行；
 * 不转换的话 <p>a\nb</p> 在浏览器里塌成「a b」。对照组：空行仍分段、围栏代码块内的换行不被改写。
 */
describe("软换行", () => {
  it("段内单个换行输出 <br>", () => {
    expect(renderMarkdown("第一行\n第二行")).toBe("<p>第一行<br>\n第二行</p>");
  });

  it("对照：空行仍然分段，不多出 <br>", () => {
    const html = renderMarkdown("第一段\n\n第二段");
    expect(html).toBe("<p>第一段</p>\n<p>第二段</p>");
    expect(html).not.toContain("<br>");
  });

  it("对照：围栏代码块内的换行保持原样，不插入 <br>", () => {
    const html = renderMarkdown("```\na\nb\n```");
    expect(html).toContain("<pre><code>a\nb\n</code></pre>");
    expect(html).not.toContain("<br>");
  });

  it("引用内的多行：每个换行都保留", () => {
    const html = renderMarkdown("> 甲\n> 乙\n> 丙");
    expect(html.match(/<br>/g)).toHaveLength(2);
  });

  it("列表项内、表格外：行尾两个空格的硬换行与软换行结果一致", () => {
    expect(renderMarkdown("a  \nb")).toBe(renderMarkdown("a\nb"));
  });

  it("表格行不受影响（行本身是结构，不会被当成软换行）", () => {
    const html = renderMarkdown("| a | b |\n| - | - |\n| 1 | 2 |");
    expect(html).toContain("<table>");
    expect(html).not.toContain("<br>");
  });
});

/** 上标 / 下标（转换器会产出 <sup> / <sub>，此前被净化剥掉，迁移库 38 篇受影响） */
describe("sup / sub", () => {
  it("标签保留", () => {
    expect(renderMarkdown("x<sup>2</sup> H<sub>2</sub>O")).toBe(
      "<p>x<sup>2</sup> H<sub>2</sub>O</p>",
    );
  });

  it("对照：属性与事件处理器仍被剥掉，内容保留", () => {
    const html = renderMarkdown('<sup onclick="alert(1)" style="position:fixed">x</sup>');
    expect(html).toBe("<p><sup>x</sup></p>");
  });

  it("对照：不在白名单的相邻标签仍被剥掉", () => {
    expect(renderMarkdown("<big>x</big>")).not.toContain("<big>");
  });
});
