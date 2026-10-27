import { describe, expect, it } from "vitest";
import { extractFeedMedia } from "./feed-media";

describe("extractFeedMedia（首页内容流封面/摘要提取）", () => {
  it("空值与空串 → 双 null", () => {
    expect(extractFeedMedia(null)).toEqual({ coverUrl: null, excerpt: null });
    expect(extractFeedMedia("")).toEqual({ coverUrl: null, excerpt: null });
  });

  it("首图进 coverUrl；图片语法从摘要中剔除；链接保留锚文本", () => {
    const r = extractFeedMedia(
      "![封面](/files/abc.jpg) 看图![第二张](/files/x.png) [字幕组](https://bbs.example.com) 出片了",
    );
    expect(r.coverUrl).toBe("/files/abc.jpg");
    expect(r.excerpt).toBe("看图 字幕组 出片了");
  });

  it("代码块整段剔除、不参与摘要；无图帖 coverUrl 为 null", () => {
    const r = extractFeedMedia("前文\n```\n![假图](/files/fake.png)\n```\n后文说明");
    expect(r.coverUrl).toBeNull();
    expect(r.excerpt).toBe("前文 后文说明");
  });

  it("全标记无正文 → excerpt 为 null；超长摘要截断到 120 字", () => {
    expect(extractFeedMedia("![只发图](/files/a.png)")).toEqual({
      coverUrl: "/files/a.png",
      excerpt: null,
    });
    const long = extractFeedMedia("好".repeat(300));
    expect(long.excerpt).toHaveLength(120);
  });
});
