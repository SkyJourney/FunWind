import { describe, expect, it } from "vitest";
import { SITE_NAME, SITE_TAGLINE } from "@/lib/site";
import { parseIdentity } from "./site-chrome";

/** 站点身份解析（M10.6b）：空值/非串回退默认；trim；截断 40/80 */
describe("parseIdentity（M10.6b）", () => {
  it("未配置/坏类型 → 默认站名与副标题", () => {
    expect(parseIdentity(null)).toEqual({ name: SITE_NAME, tagline: SITE_TAGLINE });
    expect(parseIdentity(undefined)).toEqual({ name: SITE_NAME, tagline: SITE_TAGLINE });
    expect(parseIdentity("nope")).toEqual({ name: SITE_NAME, tagline: SITE_TAGLINE });
    expect(parseIdentity({})).toEqual({ name: SITE_NAME, tagline: SITE_TAGLINE });
  });

  it("合法配置生效；空白名回退；超长截断", () => {
    expect(parseIdentity({ name: "青翼新名", tagline: "测试副标题" })).toEqual({
      name: "青翼新名",
      tagline: "测试副标题",
    });
    expect(parseIdentity({ name: "   " }).name).toBe(SITE_NAME);
    expect(parseIdentity({ name: "站".repeat(50) }).name).toHaveLength(40);
    expect(parseIdentity({ name: "x", tagline: "标".repeat(100) }).tagline).toHaveLength(80);
  });
});
