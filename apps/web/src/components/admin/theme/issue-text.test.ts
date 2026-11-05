import { describe, expect, it } from "vitest";
import {
  SURFACES,
  surfaceCapabilitiesSchema,
  themePackPwaSchema,
} from "@/lib/theme/surface-schema";
import { SHADOW_SLOTS } from "@/lib/theme/token-base";
import { COLOR_KEYS, bandSchema, shadowSchema, tokenSetSchema } from "@/lib/theme/token-schema";
import { describeIssue } from "./issue-text";

describe("describeIssue：已知路径翻成编辑器里的名字，消息原样保留", () => {
  it.each([
    [
      "pwa.themeColor: 非法颜色（须 #RRGGBB）",
      "浏览器与 PWA 颜色 · 浏览器主题色：非法颜色（须 #RRGGBB）",
    ],
    ["pwa.backgroundColor: 错", "浏览器与 PWA 颜色 · PWA 背景色：错"],
    ["pwa: Invalid input", "浏览器与 PWA 颜色：Invalid input"],
    ["tokens: 错", "全站令牌：错"],
    ["tokens.light: 错", "全站令牌 · 浅色档：错"],
    ["tokens.dark.colors: 错", "全站令牌 · 深色档 · 颜色：错"],
    [
      "tokens.light.colors.primary: 非法颜色（须 #RRGGBB）",
      "全站令牌 · 浅色档 · 颜色 · 主色：非法颜色（须 #RRGGBB）",
    ],
    ["tokens.dark.colors.card-foreground: 错", "全站令牌 · 深色档 · 颜色 · 卡片上的文字：错"],
    ["tokens.light.radius: 错", "全站令牌 · 浅色档 · 圆角：错"],
    ["tokens.dark.displayFont: 错", "全站令牌 · 深色档 · 展示字体：错"],
    ["tokens.light.shadows: 错", "全站令牌 · 浅色档 · 阴影：错"],
    ["tokens.light.shadows.s2: 错", "全站令牌 · 浅色档 · 阴影 2：错"],
    [
      "tokens.dark.shadows.s1.blur: Too big: expected number to be <=80",
      "全站令牌 · 深色档 · 阴影 1 · 模糊：Too big: expected number to be <=80",
    ],
    ["tokens.light.shadows.s3.color: 错", "全站令牌 · 浅色档 · 阴影 3 · 颜色：错"],
    ["tokens.light.shadows.s1.alpha: 错", "全站令牌 · 浅色档 · 阴影 1 · 不透明度：错"],
    ["tokens.light.brandGradient: 错", "全站令牌 · 浅色档 · 品牌渐变：错"],
    ["tokens.light.brandGradient.from: 错", "全站令牌 · 浅色档 · 品牌渐变 · 起点色：错"],
    ["tokens.light.band: 错", "全站令牌 · 浅色档 · 板块卡：错"],
    [
      "tokens.light.band.width: Too big: expected number to be <=16",
      "全站令牌 · 浅色档 · 板块卡 · 图区宽度：Too big: expected number to be <=16",
    ],
    ["tokens.light.band.maskColor: 错", "全站令牌 · 浅色档 · 板块卡 · 遮罩色：错"],
    ["tokens.light.band.mask: 错", "全站令牌 · 浅色档 · 板块卡 · 显示渐隐遮罩：错"],
    ["tokens.light.band.dim: 错", "全站令牌 · 浅色档 · 板块卡 · 整体压暗：错"],
    ["surfaces: 错", "区域设置：错"],
    ["surfaces.header: 错", "顶部导航：错"],
    ["surfaces.header.light: 错", "顶部导航 · 浅色档：错"],
    [
      "surfaces.header.light.blur: Too big: expected number to be <=24",
      "顶部导航 · 浅色档 · 毛玻璃模糊：Too big: expected number to be <=24",
    ],
    [
      "surfaces.footer.light.blur: 该区域不支持此能力",
      "页脚 · 浅色档 · 毛玻璃模糊：该区域不支持此能力",
    ],
    [
      "surfaces.footer.dark.fill.stops.0.color: 非法颜色（须 #RRGGBB）",
      "页脚 · 深色档 · 背景填充（stops.0.color）：非法颜色（须 #RRGGBB）",
    ],
    [
      "surfaces.hero-image.light.contentSlot.image: 错",
      "首页 Hero 图 · 浅色档 · 内容插槽（image）：错",
    ],
  ])("%s", (issue, expected) => {
    expect(describeIssue(issue)).toBe(expected);
  });
});

describe("describeIssue：边角", () => {
  it("只在第一个 `: ` 处拆开：消息里的冒号不影响路径", () => {
    expect(describeIssue("pwa.themeColor: 甲: 乙: 丙")).toBe(
      "浏览器与 PWA 颜色 · 浏览器主题色：甲: 乙: 丙",
    );
  });

  it("路径为空：只显示消息", () => {
    expect(describeIssue(': Unrecognized key: "unknownTop"')).toBe(
      'Unrecognized key: "unknownTop"',
    );
  });

  it("没有 `: ` 的整条原样", () => {
    expect(describeIssue("出错了")).toBe("出错了");
    expect(describeIssue("a:b")).toBe("a:b");
  });

  it("没有 `: ` 时不去猜路径：去掉最后一个字符恰好是已知路径的串也原样返回", () => {
    expect(describeIssue("pwa.themeColorx")).toBe("pwa.themeColorx");
    expect(describeIssue("surfaces.header.light.blurx")).toBe("surfaces.header.light.blurx");
  });

  it.each([
    "surfaces.foo: 未注册的区域",
    "surfaces.header.noon.fill: 错",
    "surfaces.header.light.nope: 错",
    "tokens.noon.colors.primary: 错",
    "tokens.light.colors.bogus: 错",
    "tokens.light.colors.primary.extra: 错",
    "tokens.light.radius.extra: 错",
    "tokens.light.displayFont.extra: 错",
    "tokens.light.shadows.s4.blur: 错",
    "tokens.light.shadows.s1.bogus: 错",
    "tokens.light.shadows.s1.blur.extra: 错",
    "tokens.light.brandGradient.bogus: 错",
    "tokens.light.brandGradient.from.extra: 错",
    "tokens.light.band.bogus: 错",
    "tokens.light.band.width.extra: 错",
    "tokens.light.mystery: 错",
    "pwa.bogus: 错",
    "pwa.themeColor.extra: 错",
    "elsewhere.foo: 错",
  ])("认不出的路径整条原样返回：%s", (issue) => {
    expect(describeIssue(issue)).toBe(issue);
  });

  it.each([
    "tokens.constructor.colors.primary: 错",
    "tokens.light.colors.constructor: 错",
    "tokens.light.shadows.constructor: 错",
    "tokens.light.shadows.s1.constructor: 错",
    "tokens.light.band.toString: 错",
    "surfaces.constructor.light.fill: 错",
    "surfaces.header.constructor.fill: 错",
    "surfaces.header.light.constructor: 错",
    "pwa.constructor: 错",
    "constructor.foo: 错",
  ])("原型链上的名字不会被当成键：%s", (issue) => {
    expect(describeIssue(issue)).toBe(issue);
  });
});

/** 带 ASCII 字母说明路径里还有没翻出来的原始键名；消息用「错」，所以翻译后的整条不应有任何 ASCII 字母 */
const HAS_ASCII = /[A-Za-z]/;

describe("describeIssue：按 schema 枚举，翻译后不残留原始键名", () => {
  const modes = ["light", "dark"] as const;

  it("22 个语义色 × 两档", () => {
    for (const mode of modes) {
      for (const key of COLOR_KEYS) {
        const out = describeIssue(`tokens.${mode}.colors.${key}: 错`);
        expect(out, key).not.toMatch(HAS_ASCII);
        expect(out, key).toMatch(/^全站令牌 · (浅|深)色档 · 颜色 · .+：错$/);
      }
    }
  });

  it("令牌集的每个顶层键", () => {
    for (const key of Object.keys(tokenSetSchema.shape)) {
      expect(describeIssue(`tokens.light.${key}: 错`), key).not.toMatch(HAS_ASCII);
    }
  });

  it("三档阴影 × 阴影的每个字段", () => {
    for (const slot of SHADOW_SLOTS) {
      for (const field of Object.keys(shadowSchema.shape)) {
        expect(describeIssue(`tokens.dark.shadows.${slot}.${field}: 错`), field).not.toMatch(
          HAS_ASCII,
        );
      }
    }
  });

  it("品牌渐变与板块卡的每个字段", () => {
    for (const field of Object.keys(tokenSetSchema.shape.brandGradient.unwrap().shape)) {
      expect(describeIssue(`tokens.light.brandGradient.${field}: 错`), field).not.toMatch(
        HAS_ASCII,
      );
    }
    for (const field of Object.keys(bandSchema.shape)) {
      expect(describeIssue(`tokens.light.band.${field}: 错`), field).not.toMatch(HAS_ASCII);
    }
  });

  it("每个区域 × 两档 × 每种能力", () => {
    for (const surface of SURFACES) {
      for (const mode of modes) {
        for (const capability of Object.keys(surfaceCapabilitiesSchema.shape)) {
          const out = describeIssue(`surfaces.${surface.id}.${mode}.${capability}: 错`);
          // 区域名本身可以带字母（「底部 Tab」「首页 Hero 图」），先去掉再查有没有残留的键名
          expect(out.replace(surface.label, ""), `${surface.id}.${mode}.${capability}`).not.toMatch(
            HAS_ASCII,
          );
          expect(out).toContain(surface.label);
        }
      }
    }
  });

  it("PWA 的每个字段都有名字（名字里的「PWA」三个字母除外）", () => {
    for (const key of Object.keys(themePackPwaSchema.shape)) {
      const out = describeIssue(`pwa.${key}: 错`);
      expect(out, key).not.toBe(`pwa.${key}: 错`);
      expect(out.replaceAll("PWA", ""), key).not.toMatch(HAS_ASCII);
    }
  });
});
