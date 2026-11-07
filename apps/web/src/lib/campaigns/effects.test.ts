import { describe, expect, it } from "vitest";
import {
  CAMPAIGN_EFFECTS,
  CAMPAIGN_EFFECT_KEYS,
  configFromTarget,
  findCampaignEffect,
  siteHeroEffect,
  siteLogoEffect,
  targetOfConfig,
  themePackEffect,
  validateCampaignConfig,
} from "./effects";

describe("运营排期 effect 注册表", () => {
  it("注册键清单精确（新增 effect 必须同步消费者与测试）", () => {
    expect([...CAMPAIGN_EFFECT_KEYS]).toEqual(["theme.pack", "site.logo", "site.hero"]);
    expect(CAMPAIGN_EFFECTS).toHaveLength(3);
  });

  it("每个 effect 都有非空 label 与可调用 describe", () => {
    for (const effect of CAMPAIGN_EFFECTS) {
      expect(effect.label.trim()).not.toBe("");
      expect(typeof effect.describe).toBe("function");
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
  });

  describe("目标字段与配置互转", () => {
    it("每个 effect 声明的目标字段决定配置形态", () => {
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

  // —— M11.4 Step 0：注册表扩展（kind + effect 自管的选项值互转）——

  describe("效果类别与互转声明（M11.4 Step 0）", () => {
    it("每个 effect 都声明 kind 与可调用的选项值互转", () => {
      for (const effect of CAMPAIGN_EFFECTS) {
        expect(["visual", "behavior"]).toContain(effect.kind);
        expect(typeof effect.toConfig).toBe("function");
        expect(typeof effect.toValue).toBe("function");
      }
    });

    it("M11.2 三个视觉 effect：kind=visual、不带自带选项（选项由页面按库生成）", () => {
      for (const effect of [themePackEffect, siteLogoEffect, siteHeroEffect]) {
        expect(effect.kind).toBe("visual");
        expect(effect.fixedOptions).toBeUndefined();
      }
    });

    it("互转往返：合法选项值 → 配置 → 通过严格校验 → 还原同一选项值", () => {
      const cases = [
        ["theme.pack", "xmas-2026"],
        ["site.logo", "logo-aaaa1111.png"],
        ["site.hero", "hero-bbbb2222.png"],
      ] as const;
      for (const [key, value] of cases) {
        const config = configFromTarget(key, value);
        expect(config).not.toBeNull();
        expect(validateCampaignConfig(key, config).ok).toBe(true);
        expect(targetOfConfig(key, config)).toBe(value);
      }
    });

    it("非法选项值在组装配置时即被拒绝（后台提交值恒为字符串，不能靠类型系统兜底）", () => {
      expect(configFromTarget("theme.pack", "BAD ID")).toBeNull();
      expect(configFromTarget("theme.pack", "")).toBeNull();
      expect(configFromTarget("site.logo", "hero-aaaa1111.png")).toBeNull();
      expect(configFromTarget("site.hero", "logo-aaaa1111.png")).toBeNull();
    });
  });
});
