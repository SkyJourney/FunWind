import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

/**
 * 精简 GFM（表格 + 删除线）的行为测试。
 * 数据来自迁移库实测（见 gfm-lite.ts）：22 个表格帖、1199 篇删除线、1328 篇单波浪线语气词。
 */
describe("表格", () => {
  it("基本表格渲染为 <table>，表头 / 表体分开", () => {
    const html = renderMarkdown("| 名称 | 数量 |\n| --- | --- |\n| 苹果 | 3 |\n| 梨 | 5 |");
    expect(html).toContain("<table>");
    expect(html).toMatch(/<thead>\s*<tr>\s*<th>名称<\/th>\s*<th>数量<\/th>/);
    expect(html).toMatch(/<tbody>[\s\S]*<td>苹果<\/td>[\s\S]*<td>5<\/td>/);
    expect(html).not.toContain("| ---");
  });

  it("对齐标记转成 align 属性（净化白名单放行）", () => {
    const html = renderMarkdown("| 左 | 中 | 右 |\n|:---|:---:|---:|\n| a | b | c |");
    expect(html).toContain('align="center"');
    expect(html).toContain('align="right"');
  });

  it("单元格内的行内格式与转义竖线", () => {
    const html = renderMarkdown("| a | b |\n| - | - |\n| **粗** | x \\| y |");
    expect(html).toContain("<strong>粗</strong>");
    expect(html).toContain("x | y");
  });

  it("迁移转换器产出的一行表格（聊天记录类）也正常渲染", () => {
    const html = renderMarkdown("| 宝贝冰月 23:13:45 日期:2010/5/31 在么~ |\n| --- |");
    expect(html).toContain("<table>");
    expect(html).toContain("在么~");
  });

  it("不是表格的竖线文字保持原样：没有分隔行", () => {
    const html = renderMarkdown("a | b | c\n结束");
    expect(html).not.toContain("<table>");
  });
});

describe("删除线", () => {
  it("双波浪线 = 删除线", () => {
    expect(renderMarkdown("~~删除线~~")).toContain("<del>删除线</del>");
    expect(renderMarkdown("前 ~~中间~~ 后")).toContain("前 <del>中间</del> 后");
  });

  it("单波浪线不是删除线：中文论坛习惯的语气词（singleTilde=false，实测会误伤 1328 篇）", () => {
    for (const s of [
      "握爪~我也是今年5月份~好在图书馆什么书都有",
      "这季的俺都还没顾上看~等出完了再慢慢看~",
      "哇~上野树里~期待ing~",
      "更新到第1~12集",
      "共 3~5 人，预计 10~20 分钟",
    ]) {
      const html = renderMarkdown(s);
      expect(html, s).not.toContain("<del>");
      expect(html, s).toContain("~");
    }
  });

  it("装饰性的多波浪线不会变成删除线", () => {
    const html = renderMarkdown("~~~~~~~~ 分割 ~~~~~~~~");
    expect(html).not.toContain("<del>");
  });

  it("未闭合的 ~~ 保持文字", () => {
    expect(renderMarkdown("开头 ~~ 没有结尾")).not.toContain("<del>");
  });

  it("删除线与表格 / 引用 / 列表可嵌套", () => {
    expect(renderMarkdown("> ~~旧~~ 新")).toMatch(/<blockquote>[\s\S]*<del>旧<\/del>/);
    expect(renderMarkdown("- ~~a~~\n- b")).toContain("<del>a</del>");
    expect(renderMarkdown("| x |\n| - |\n| ~~y~~ |")).toContain("<del>y</del>");
  });
});

describe("没有启用的 GFM 特性（刻意）", () => {
  it("裸 URL 不自动成链：中文紧跟在 URL 后面时 remark-gfm 的自动链接会把中文吞进去", () => {
    const html = renderMarkdown("下载 http://pan.baidu.com/s/1o67AOzS啊哦，你来看");
    expect(html).not.toContain("<a ");
  });

  it("邮箱不自动成链；任务列表不生成 <input>", () => {
    expect(renderMarkdown("联系 someone@example.com")).not.toContain("<a ");
    const html = renderMarkdown("- [ ] 待办\n- [x] 完成");
    expect(html).not.toContain("<input");
    expect(html).toContain("[ ] 待办");
  });

  it("脚注语法不启用", () => {
    expect(renderMarkdown("文字[^1]\n\n[^1]: 注")).not.toContain("footnote");
  });
});
