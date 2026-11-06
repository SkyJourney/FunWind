import { describe, expect, it } from "vitest";
import {
  CAMPAIGN_EFFECTS,
  CAMPAIGN_EFFECT_KEYS,
  configFromFormValue,
  configFromTarget,
  findCampaignEffect,
  formValueOfConfig,
  targetOfConfig,
  themePackEffect,
  validateCampaignConfig,
} from "./effects";

describe("运营排期 effect 注册表", () => {
  it("注册键清单精确（新增 effect 必须同步消费者与测试）", () => {
    expect([...CAMPAIGN_EFFECT_KEYS]).toEqual([
      "theme.pack",
      "site.logo",
      "site.hero",
      "register.open",
      "points.boost",
    ]);
    expect(CAMPAIGN_EFFECTS).toHaveLength(5);
  });

  it("每个 effect 都有非空 label、field 定义与可调用 describe", () => {
    for (const effect of CAMPAIGN_EFFECTS) {
      expect(effect.label.trim()).not.toBe("");
      expect(effect.field).toBeDefined();
      expect(effect.field.type).toMatch(/^(none|select|number)$/);
      expect(typeof effect.describe).toBe("function");
    }
  });

  it("M11.2 三个 effect 都是 select 字段类型", () => {
    for (const effect of [
      themePackEffect,
      ...CAMPAIGN_EFFECTS.filter((e) => e.key.startsWith("site.")),
    ]) {
      expect(effect.field.type).toBe("select");
      if (effect.field.type === "select") {
        expect(effect.field.fieldName).toBeDefined();
      }
    }
  });

  it("未注册的 effect 键返回 null（读侧据此跳过、写侧据此拒绝）", () => {
    expect(findCampaignEffect("site.decor")).toBeNull();
    expect(findCampaignEffect("")).toBeNull();
    expect(findCampaignEffect("THEME.PACK")).toBeNull();
  });

  describe("配置严格校验", () => {
    it("theme.pack：合法包 id 通过，摘要可读", () => {
      const result = validateCampaignConfig("theme.pack", { pack: "xmas-2026" });
      expect(result.ok).toBe(true);
      expect(themePackEffect.describe({ pack: "xmas-2026" })).toBe("主题包 → xmas-2026");
    });

    it("theme.pack：未知字段被拒绝（strict，防拼写错误静默生效）", () => {
      const result = validateCampaignConfig("theme.pack", { pack: "xmas", extra: 1 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message.length).toBeGreaterThan(0);
    });

    it("theme.pack：非法 id（大写 / 过短 / 含空格）一律拒绝", () => {
      for (const pack of ["Xmas", "a", "xmas 2026", "", "-lead"]) {
        expect(validateCampaignConfig("theme.pack", { pack }).ok).toBe(false);
      }
    });

    it("site.logo / site.hero：文件名正则口径不同，不能混用", () => {
      expect(validateCampaignConfig("site.logo", { file: `logo-${"a".repeat(8)}.png` }).ok).toBe(
        true,
      );
      expect(validateCampaignConfig("site.logo", { file: `hero-${"a".repeat(8)}.png` }).ok).toBe(
        false,
      );
      expect(validateCampaignConfig("site.hero", { file: `hero-${"a".repeat(8)}.png` }).ok).toBe(
        true,
      );
      expect(validateCampaignConfig("site.hero", { file: `logo-${"a".repeat(8)}.png` }).ok).toBe(
        false,
      );
    });

    it("拒绝路径穿越与 URL 形式（只接受池内文件名）", () => {
      for (const file of ["../../etc/passwd", "/brand/logo", "https://x/y.png", "logo-.png"]) {
        expect(validateCampaignConfig("site.logo", { file }).ok).toBe(false);
      }
    });

    it("非对象配置（null / 数组 / 字符串）一律拒绝", () => {
      for (const config of [null, [], "theme.pack", 42]) {
        expect(validateCampaignConfig("theme.pack", config).ok).toBe(false);
      }
    });

    it("未注册 effect 的配置校验直接失败，且提示含键名", () => {
      const result = validateCampaignConfig("site.decor", { file: "decor-x.png" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("site.decor");
    });

    it("register.open：无参数，config 为空对象", () => {
      const result = validateCampaignConfig("register.open", {});
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toEqual({});
    });

    it("register.open：多一个字段就拒绝（strict）", () => {
      const result = validateCampaignConfig("register.open", { extra: "field" });
      expect(result.ok).toBe(false);
    });

    it("points.boost：有效倍率（2-10）通过校验", () => {
      for (const ratio of [2, 3, 5, 10]) {
        const result = validateCampaignConfig("points.boost", { ratio });
        expect(result.ok).toBe(true);
      }
    });

    it("points.boost：非法倍率（<2 或 >10）拒绝", () => {
      for (const ratio of [1, 0, -1, 11, 100]) {
        const result = validateCampaignConfig("points.boost", { ratio });
        expect(result.ok).toBe(false);
      }
    });

    it("points.boost：非整数倍率拒绝", () => {
      const result = validateCampaignConfig("points.boost", { ratio: 2.5 });
      expect(result.ok).toBe(false);
    });
  });

  describe("M11.2 兼容 API：目标字段与配置互转（向后兼容，deprecated）", () => {
    it("每个 select effect 的目标字段决定配置形态", () => {
      expect(configFromTarget("theme.pack", "xmas-2026")).toEqual({ pack: "xmas-2026" });
      expect(configFromTarget("site.logo", "logo-aaaa1111.png")).toEqual({
        file: "logo-aaaa1111.png",
      });
      expect(configFromTarget("site.decor", "x")).toBeNull();
    });

    it("互转可逆；形态不符或未注册返回 null", () => {
      expect(targetOfConfig("theme.pack", { pack: "xmas-2026" })).toBe("xmas-2026");
      expect(targetOfConfig("site.hero", { file: "hero-bbbb2222.png" })).toBe("hero-bbbb2222.png");
      expect(targetOfConfig("theme.pack", { file: "x" })).toBeNull();
      expect(targetOfConfig("theme.pack", null)).toBeNull();
      expect(targetOfConfig("site.decor", { file: "x" })).toBeNull();
    });
  });

  describe("M11.4+ 新 API：表单字段值与配置互转（支持多种字段类型）", () => {
    it("select effect：表单字符串值 → 配置", () => {
      expect(configFromFormValue("theme.pack", "xmas-2026")).toEqual({ pack: "xmas-2026" });
      expect(configFromFormValue("site.logo", "logo-x.png")).toEqual({ file: "logo-x.png" });
    });

    it("select effect：配置 → 表单字符串值", () => {
      expect(formValueOfConfig("theme.pack", { pack: "xmas-2026" })).toBe("xmas-2026");
      expect(formValueOfConfig("site.hero", { file: "hero-y.png" })).toBe("hero-y.png");
    });

    it("未注册 effect 的互转返回 null", () => {
      expect(configFromFormValue("site.decor", "x")).toBeNull();
      expect(formValueOfConfig("site.decor", { file: "x" })).toBeNull();
    });
  });
});
