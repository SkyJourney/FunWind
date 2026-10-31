import { describe, expect, it } from "vitest";
import { resolveEffectivePack } from "./theme-pref";

describe("resolveEffectivePack（生效主题包合成）", () => {
  it("用户偏好优先于站点默认", () => {
    expect(resolveEffectivePack("qy2010", "default")).toBe("qy2010");
  });

  it("用户未设（null/undefined）→ 站点默认", () => {
    expect(resolveEffectivePack(null, "qy2010")).toBe("qy2010");
    expect(resolveEffectivePack(undefined, "qy2010")).toBe("qy2010");
  });

  it("两者皆空 → default 兜底", () => {
    expect(resolveEffectivePack(null, null)).toBe("default");
    expect(resolveEffectivePack(undefined, undefined)).toBe("default");
  });
});
