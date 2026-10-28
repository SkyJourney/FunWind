import { describe, expect, it } from "vitest";
import { GATE_PREVIEW_NOTE, previewHtml } from "./preview";

describe("previewHtml：编辑器预览", () => {
  it("公开正文经站点渲染器输出", () => {
    expect(previewHtml("**粗体**")).toContain("<strong>粗体</strong>");
  });

  it("门控正文不出现在预览中，只显示占位说明（泄露回归）", () => {
    const html = previewHtml(
      `公开前言\n\n:::gate{key="g1" unlock="points" price="10"}\nSECRET-PREVIEW 隐藏正文\n:::`,
    );
    expect(html).toContain("公开前言");
    expect(html).not.toContain("SECRET-PREVIEW");
    expect(html).toContain("锁定内容");
  });

  it("语法有误的门控不让预览中断，公开部分照常渲染", () => {
    expect(() => previewHtml(`前文\n\n:::gate{key="x" unlock="unknown"}\n内容\n:::`)).not.toThrow();
    expect(previewHtml(`前文\n\n:::gate{key="x" unlock="unknown"}\n内容\n:::`)).toContain("前文");
  });

  it("占位说明常量与输出一致", () => {
    expect(previewHtml(`:::gate{key="g1" unlock="reply"}\n隐藏\n:::`)).toContain("锁定内容");
    expect(GATE_PREVIEW_NOTE).toContain("锁定内容");
  });
});
