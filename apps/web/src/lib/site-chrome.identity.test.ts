import { describe, expect, it } from "vitest";
import { SITE_NAME, SITE_TAGLINE, SITE_URL } from "@/lib/site";
import { parseIdentity } from "./site-chrome";

/** 站点身份解析（M10.6b/c）：空值/非串回退默认；trim；截断 40/80；url 校验（M10.6 收尾） */
describe("parseIdentity（M10.6）", () => {
  it("未配置/坏类型 → 默认站名、副标题与环境地址", () => {
    expect(parseIdentity(null)).toEqual({
      name: SITE_NAME,
      tagline: SITE_TAGLINE,
      url: SITE_URL,
    });
    expect(parseIdentity(undefined)).toEqual({
      name: SITE_NAME,
      tagline: SITE_TAGLINE,
      url: SITE_URL,
    });
    expect(parseIdentity("nope")).toEqual({
      name: SITE_NAME,
      tagline: SITE_TAGLINE,
      url: SITE_URL,
    });
    expect(parseIdentity({})).toEqual({
      name: SITE_NAME,
      tagline: SITE_TAGLINE,
      url: SITE_URL,
    });
  });

  it("合法配置生效；空白名回退；超长截断", () => {
    expect(parseIdentity({ name: "青翼新名", tagline: "测试副标题" })).toEqual({
      name: "青翼新名",
      tagline: "测试副标题",
      url: SITE_URL,
    });
    expect(parseIdentity({ name: "   " }).name).toBe(SITE_NAME);
    expect(parseIdentity({ name: "站".repeat(50) }).name).toHaveLength(40);
    expect(parseIdentity({ name: "x", tagline: "标".repeat(100) }).tagline).toHaveLength(80);
  });

  it("url：合法值生效并去尾斜杠；非法/空回退环境地址", () => {
    expect(parseIdentity({ url: "https://qingyisub.top" }).url).toBe("https://qingyisub.top");
    expect(parseIdentity({ url: "https://qingyisub.top///" }).url).toBe("https://qingyisub.top");
    expect(parseIdentity({ url: "" }).url).toBe(SITE_URL);
    expect(parseIdentity({ url: "ftp://x" }).url).toBe(SITE_URL);
    expect(parseIdentity({ url: "qingyisub.top" }).url).toBe(SITE_URL);
    expect(parseIdentity({ url: "https://x." + "a".repeat(300) }).url).toHaveLength(200);
  });
});
