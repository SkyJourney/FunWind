// @vitest-environment node
import { describe, expect, it } from "vitest";
import { BUILTIN_THEME_PACK_SEEDS } from "@funwind/db";
import { cssTextForPack, renderPackCssVars } from "./surface-render";
import {
  parseThemePackDefinition,
  type ThemePackDefinition,
  type ThemePackTokens,
} from "./surface-schema";

/**
 * 令牌层与包定义的集成（M11.6 Step 1）：schema → 渲染变量 → CSS 文本。
 * token-schema / token-render 的单测各自只覆盖一段；这里覆盖它们接进 definition 的几处接缝，
 * 任何一处断开（schema 忘了收 tokens、渲染没并入 :root / 深色块、错误地继承 default 包）都会变红。
 */

const TOKENS: ThemePackTokens = {
  light: {
    colors: { primary: "#147ba9", "card-foreground": "#33332f" },
    radius: "sm",
  },
  dark: { colors: { primary: "#22d3ee" } },
};

const def = (
  tokens: ThemePackTokens | undefined,
  surfaces: ThemePackDefinition["surfaces"] = {},
): ThemePackDefinition => ({ surfaces, ...(tokens ? { tokens } : {}) });

describe("parseThemePackDefinition 与 tokens", () => {
  it("接受带 tokens 的定义，值原样保留", () => {
    const result = parseThemePackDefinition({ surfaces: {}, tokens: TOKENS });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.tokens).toEqual(TOKENS);
  });

  it("没有 tokens 的旧定义照常通过，且输出里不会凭空多出 tokens 键", () => {
    const result = parseThemePackDefinition({ surfaces: {} });
    expect(result.ok).toBe(true);
    if (result.ok) expect(Object.keys(result.value)).toEqual(["surfaces"]);
  });

  it.each([
    ["未知颜色键", { light: { colors: { nope: "#000000" } } }, "tokens.light.colors"],
    ["颜色不是 #RRGGBB", { light: { colors: { primary: "red" } } }, "tokens.light.colors.primary"],
    [
      "颜色值夹带标签",
      { light: { colors: { primary: "#000;}</style><script>" } } },
      "tokens.light.colors.primary",
    ],
    ["圆角档位不存在", { light: { radius: "huge" } }, "tokens.light.radius"],
    ["深色档同样严格", { dark: { colors: { primary: "red" } } }, "tokens.dark.colors.primary"],
    ["tokens 内有未知字段", { light: {}, extra: {} }, "tokens"],
    ["tokens 不是对象", "x", "tokens"],
    ["tokens 是数组", [], "tokens"],
  ])("拒绝：%s", (_label, tokens, pathPrefix) => {
    const result = parseThemePackDefinition({ surfaces: {}, tokens });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.startsWith(pathPrefix))).toBe(true);
    }
  });

  it("顶层出现未知段仍被拒绝（tokens 不是放开顶层的口子）", () => {
    expect(parseThemePackDefinition({ surfaces: {}, extra: 1 }).ok).toBe(false);
  });
});

describe("renderPackCssVars 与 tokens", () => {
  it("浅色令牌进 root:light，深色令牌进 root:dark", () => {
    const out = renderPackCssVars(def(TOKENS));
    expect(out["root:light"]).toEqual({
      "--primary": "#147ba9",
      "--card-foreground": "#33332f",
      "--radius": "var(--fw-radius-sm)",
    });
    expect(out["root:dark"]).toEqual({ "--primary": "#22d3ee" });
  });

  it("只有浅色档的包：深色块为空（深色模式回退基础层）", () => {
    const out = renderPackCssVars(def({ light: { colors: { primary: "#147ba9" } } }));
    expect(out["root:dark"]).toEqual({});
  });

  it("没有 tokens 的包：行为与引入令牌之前一致", () => {
    expect(renderPackCssVars(def(undefined))).toEqual({ "root:light": {}, "root:dark": {} });
  });

  it("令牌与表面变量并存，互不覆盖", () => {
    const out = renderPackCssVars(
      def(TOKENS, { header: { light: { fill: { type: "solid", color: "#112233" } } } }),
    );
    expect(out["root:light"]["--sf-header-bg"]).toBe("#112233");
    expect(out["root:light"]["--primary"]).toBe("#147ba9");
  });

  it("只渲染本包自己的令牌，不继承 fallbackDefinition 的令牌", () => {
    const fallback = def({
      light: { colors: { primary: "#000000" }, radius: "xl" },
      dark: { colors: { primary: "#ffffff" } },
    });
    const own = renderPackCssVars(def({ light: { colors: { primary: "#147ba9" } } }), fallback);
    expect(own["root:light"]).toEqual({ "--primary": "#147ba9" });
    expect(own["root:dark"]).toEqual({});
    expect(renderPackCssVars(def(undefined), fallback)).toEqual({
      "root:light": {},
      "root:dark": {},
    });
  });
});

describe("cssTextForPack 与 tokens", () => {
  it("黄金串：浅色块限定在非深色模式，深色块限定在深色模式，颜色规范化为小写", () => {
    const css = cssTextForPack(
      "demo",
      def({
        light: { colors: { primary: "#147BA9" }, radius: "sm" },
        dark: { colors: { primary: "#22D3EE" } },
      }),
    );
    expect(css).toBe(
      [
        ':root[data-pack="demo"]:not([data-mode="dark"]) {',
        "  --primary: #147ba9;",
        "  --radius: var(--fw-radius-sm);",
        "}",
        ':root[data-pack="demo"][data-mode="dark"] {',
        "  --primary: #22d3ee;",
        "}",
      ].join("\n"),
    );
  });

  it("只有浅色档时不输出深色块", () => {
    const css = cssTextForPack("demo", def({ light: { colors: { primary: "#147ba9" } } }));
    expect(css).toBe(
      [':root[data-pack="demo"]:not([data-mode="dark"]) {', "  --primary: #147ba9;", "}"].join(
        "\n",
      ),
    );
  });

  it("既没有表面也没有令牌时输出空串", () => {
    expect(cssTextForPack("demo", def(undefined))).toBe("");
  });

  it("包 id 不合法时抛错", () => {
    expect(() => cssTextForPack("Bad Id", def(undefined))).toThrow("非法主题包 id");
  });

  it("完整令牌集经 parse → 渲染的整条链路：输出不含尖括号与反斜杠，渐变色标位置完整", () => {
    const parsed = parseThemePackDefinition({
      surfaces: {},
      tokens: {
        light: {
          colors: { primary: "#147ba9", background: "#f6f3e7" },
          radius: "sm",
          shadows: {
            s1: { x: 0, y: 1, blur: 2, spread: 0, color: "#786428", alpha: 0.1 },
          },
          displayFont: "songti",
          brandGradient: { angle: 120, from: "#9bcba5", to: "#efe9b5" },
          band: { width: 8.5, angle: 90, fade: 0, dim: 1, mask: false },
        },
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const css = cssTextForPack("demo", parsed.value);
    expect(css).not.toMatch(/[<>\\]/);
    expect(css).toContain("--gradient-brand: linear-gradient(120deg, #9bcba5 0%, #efe9b5 100%);");
    expect(css).toContain("--shadow-1: 0px 1px 2px 0px rgb(120 100 40 / 0.1);");
    expect(css).toContain('--fw-font-display: "Songti SC", "STSong", SimSun, Georgia, serif;');
  });
});

describe("内置种子的有效性", () => {
  it.each(BUILTIN_THEME_PACK_SEEDS.map((seed) => [seed.id, seed.definition] as const))(
    "种子 %s 的定义通过校验并能渲染",
    (id, definition) => {
      const parsed = parseThemePackDefinition(definition);
      expect(parsed.ok, parsed.ok ? "" : parsed.errors.join("; ")).toBe(true);
      if (parsed.ok) expect(() => cssTextForPack(id, parsed.value)).not.toThrow();
    },
  );

  it("至少有 default 种子（防止参数化用例因空数组而空转；qy2010 已于 2026-11-08 移出）", () => {
    expect(BUILTIN_THEME_PACK_SEEDS.map((seed) => seed.id)).toEqual(
      expect.arrayContaining(["default"]),
    );
  });
});
