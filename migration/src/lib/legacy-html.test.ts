import { describe, expect, it } from "vitest";
import { sanitizeLegacyHtml } from "./legacy-html.js";

describe("sanitizeLegacyHtml（D5 迁移清洗）", () => {
  it("剥离标签：<br> 转空格，img/a/font 整体丢弃，保留纯文本", () => {
    expect(
      sanitizeLegacyHtml('<img src="http://x/a.jpg"> 说明&amp;指南 <a href="#">链接</a><br>第二行'),
    ).toBe("说明&指南 链接 第二行");
  });

  it("实体解码与空白收敛；font 颜色类丢弃", () => {
    expect(sanitizeLegacyHtml('<font color="#5858FA">制作中</font>&nbsp;｜&nbsp;<b>2010</b>')).toBe(
      "制作中 ｜ 2010",
    );
  });

  it("空值口径：null/空串/全标签空白 → null；纯文本原样", () => {
    expect(sanitizeLegacyHtml(null)).toBeNull();
    expect(sanitizeLegacyHtml("")).toBeNull();
    expect(sanitizeLegacyHtml("<b> </b>")).toBeNull();
    expect(sanitizeLegacyHtml("喜欢欢日剧的同志快进来聚聚聊★")).toBe(
      "喜欢欢日剧的同志快进来聚聚聊★",
    );
  });
});
