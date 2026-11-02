import { describe, expect, it } from "vitest";
import { renderMail } from "./layout";
import { FALLBACK_BRAND } from "./brand";
import type { MailBrand } from "./types";

const BRAND: MailBrand = {
  siteName: "测试站",
  siteUrl: "https://example.test",
  tagline: "测试标语",
  accent: "#0e7490",
};

const BASE = { scene: "unit", brand: BRAND } as const;

describe("renderMail · HTML 结构", () => {
  it("主题缺省为「标题 · 站名」，指定时用指定值；kind/scene 透传", () => {
    const m = renderMail({ ...BASE, kind: "verify", title: "验证邮箱", paragraphs: [] });
    expect(m.subject).toBe("验证邮箱 · 测试站");
    expect(m.kind).toBe("verify");
    expect(m.scene).toBe("unit");
    expect(
      renderMail({ ...BASE, kind: "system", title: "t", subject: "自定义主题", paragraphs: [] })
        .subject,
    ).toBe("自定义主题");
  });

  it("按钮下方必有备用链接（HTML 与纯文本都含 href）", () => {
    const m = renderMail({
      ...BASE,
      kind: "verify",
      title: "t",
      paragraphs: [],
      action: { href: "https://example.test/verify/abc", label: "验证邮箱" },
    });
    expect(m.html).toContain("https://example.test/verify/abc</a>");
    expect(m.html).toContain("按钮无法点击时");
    expect(m.text).toContain("验证邮箱：https://example.test/verify/abc");
  });

  it("所有动态文本转义，**粗体** 轻标记生效", () => {
    const m = renderMail({
      ...BASE,
      kind: "notice",
      title: "标题<script>",
      paragraphs: ["含 **加粗** 与 <img src=x> 的段落"],
      fields: [{ label: "理由", value: "<script>alert(1)</script>" }],
      quote: "引用<b>内容</b>",
    });
    expect(m.html).not.toContain("<script>");
    expect(m.html).not.toContain("<img src=x>");
    expect(m.html).toContain("<b>加粗</b>");
    expect(m.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("安全类顶边用琥珀色，其余用品牌色", () => {
    const security = renderMail({ ...BASE, kind: "security", title: "t", paragraphs: [] });
    const verify = renderMail({ ...BASE, kind: "verify", title: "t", paragraphs: [] });
    expect(security.html).toContain("border-top:4px solid #b45309");
    expect(verify.html).toContain("border-top:4px solid #0e7490");
  });
});

describe("renderMail · 四类页脚", () => {
  it("verify：默认「可忽略」话术，无管理入口", () => {
    const m = renderMail({ ...BASE, kind: "verify", title: "t", paragraphs: [] });
    expect(m.html).toContain("可以放心忽略");
    expect(m.html).not.toContain("/settings/notifications");
  });

  it("security：默认「不受通知偏好控制」", () => {
    const m = renderMail({ ...BASE, kind: "security", title: "t", paragraphs: [] });
    expect(m.html).toContain("不受通知偏好控制");
  });

  it("notice / digest：页脚追加「设置 → 通知」管理入口（HTML 链接与纯文本都在）", () => {
    for (const kind of ["notice", "digest"] as const) {
      const m = renderMail({ ...BASE, kind, title: "t", paragraphs: [] });
      expect(m.html).toContain('href="https://example.test/settings/notifications"');
      expect(m.text).toContain("管理邮件提醒：https://example.test/settings/notifications");
    }
  });

  it("模板指定 footer 覆盖类别缺省", () => {
    const m = renderMail({
      ...BASE,
      kind: "notice",
      title: "t",
      paragraphs: [],
      footer: "同一会话每小时最多提醒一次。",
    });
    expect(m.html).toContain("同一会话每小时最多提醒一次。");
    expect(m.html).not.toContain("你收到这封邮件是因为开启了相应的邮件提醒。");
  });
});

describe("renderMail · 纯文本版", () => {
  it("标题/段落/字段/列表/提示/品牌行齐全，且不含 HTML 标签与轻标记", () => {
    const m = renderMail({
      ...BASE,
      kind: "digest",
      title: "你的社区动态",
      paragraphs: ["过去一天里，这些动态在等你："],
      list: ["未读私信 **2** 条"],
      note: "每天最多一封",
    });
    expect(m.text).toContain("你的社区动态");
    expect(m.text).toContain("· 未读私信 2 条");
    expect(m.text).toContain("每天最多一封");
    expect(m.text).toContain("测试站 · https://example.test");
    expect(m.text).not.toContain("<");
    expect(m.text).not.toContain("**");
  });
});

describe("FALLBACK_BRAND", () => {
  it("缺省品牌可用且主题为默认色（纯函数模板的兜底）", () => {
    expect(FALLBACK_BRAND.accent).toBe("#0e7490");
    expect(FALLBACK_BRAND.siteName.length).toBeGreaterThan(0);
    expect(FALLBACK_BRAND.siteUrl).toMatch(/^https?:\/\//);
  });
});
