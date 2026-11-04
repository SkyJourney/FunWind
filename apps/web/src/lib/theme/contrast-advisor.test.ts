import { describe, expect, it } from "vitest";
import {
  compositeOver,
  contrastRatio,
  evaluateContrast,
  relativeLuminance,
  TEXT_CONTRAST_MIN,
} from "./contrast-advisor";
import type { ColorKey } from "./token-schema";

describe("contrast-advisor", () => {
  describe("relativeLuminance", () => {
    it("黑色亮度接近 0", () => {
      expect(relativeLuminance([0, 0, 0])).toBeCloseTo(0, 3);
    });

    it("白色亮度接近 1", () => {
      expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 3);
    });

    it("中灰 #767676 的亮度", () => {
      expect(relativeLuminance([118, 118, 118])).toBeCloseTo(0.18, 2);
    });
  });

  describe("contrastRatio", () => {
    it("黑白对比 21:1", () => {
      expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 1);
    });

    it("#767676 与白色的对比约 4.54", () => {
      expect(contrastRatio([118, 118, 118], [255, 255, 255])).toBeCloseTo(4.54, 2);
    });

    it("相同颜色对比 1:1", () => {
      expect(contrastRatio([100, 100, 100], [100, 100, 100])).toBeCloseTo(1, 2);
    });
  });

  describe("compositeOver", () => {
    it("黑色 10% alpha 叠加白色", () => {
      const result = compositeOver([0, 0, 0], [255, 255, 255], 0.1);
      expect(result).toEqual([230, 230, 230]);
    });

    it("alpha = 1 完全覆盖", () => {
      const result = compositeOver([100, 100, 100], [200, 200, 200], 1);
      expect(result).toEqual([100, 100, 100]);
    });

    it("alpha = 0 完全透明", () => {
      const result = compositeOver([100, 100, 100], [200, 200, 200], 0);
      expect(result).toEqual([200, 200, 200]);
    });
  });

  describe("evaluateContrast", () => {
    const defaultLightColors: Record<ColorKey, string> = {
      background: "#f8fafc",
      foreground: "#0f172a",
      card: "#ffffff",
      "card-foreground": "#0f172a",
      popover: "#ffffff",
      "popover-foreground": "#0f172a",
      primary: "#0e7490",
      "primary-foreground": "#ffffff",
      secondary: "#f1f5f9",
      "secondary-foreground": "#334155",
      muted: "#f1f5f9",
      "muted-foreground": "#64748b",
      accent: "#f1f5f9",
      "accent-foreground": "#0f172a",
      destructive: "#b91c1c",
      "destructive-foreground": "#ffffff",
      success: "#166534",
      warning: "#8a5200",
      info: "#1d4ed8",
      border: "#e2e8f0",
      input: "#e2e8f0",
      ring: "#0e7490",
    };

    it("返回 18 项检查", () => {
      const result = evaluateContrast(defaultLightColors);
      expect(result).toHaveLength(18);
    });

    it("每项含 id / label / fg / bg / ratio / pass", () => {
      const result = evaluateContrast(defaultLightColors);
      result.forEach((check) => {
        expect(check).toHaveProperty("id");
        expect(check).toHaveProperty("label");
        expect(check).toHaveProperty("fg");
        expect(check).toHaveProperty("bg");
        expect(check).toHaveProperty("ratio");
        expect(check).toHaveProperty("pass");
        expect(typeof check.ratio).toBe("number");
        expect(typeof check.pass).toBe("boolean");
      });
    });

    it("default 主题大部分组合通过", () => {
      const result = evaluateContrast(defaultLightColors);
      const passed = result.filter((c) => c.pass);
      expect(passed.length).toBeGreaterThan(10);
    });

    it("阈值为 4.5", () => {
      expect(TEXT_CONTRAST_MIN).toBe(4.5);
    });

    it("包含淡底检查（tintAlpha = 0.1）", () => {
      const result = evaluateContrast(defaultLightColors);
      const tintChecks = result.filter((c) => "tintAlpha" in c);
      expect(tintChecks.length).toBe(8);
      tintChecks.forEach((c) => {
        expect(c.label).toMatch(/淡底/);
      });
    });
  });
});
