import { describe, expect, it } from "vitest";
import { parseThemePack } from "./site-chrome";

describe("parseThemePack（site.theme 全站默认主题解析）", () => {
  it("合法包 id 原样返回", () => {
    expect(parseThemePack({ pack: "qy2010" })).toBe("qy2010");
    expect(parseThemePack({ pack: "default" })).toBe("default");
  });

  it("未配置 / 坏结构 / 不在注册表 → default（不抛错）", () => {
    expect(parseThemePack(undefined)).toBe("default");
    expect(parseThemePack(null)).toBe("default");
    expect(parseThemePack("junk")).toBe("default");
    expect(parseThemePack({ pack: "retired-pack" })).toBe("default");
    expect(parseThemePack({ pack: 42 })).toBe("default");
  });
});
