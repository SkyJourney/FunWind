import { describe, expect, it } from "vitest";
import type { ThemePackDefinition } from "@/lib/theme/surface-schema";
import { BASE_BAND, BASE_SHADOWS, SHADOW_SLOTS } from "@/lib/theme/token-base";
import {
  COLOR_KEYS,
  bandSchema,
  shadowSchema,
  tokenSetSchema,
  tokensSchema,
  type Shadow,
  type TokenSet,
} from "@/lib/theme/token-schema";
import { parseBounded } from "./number-field";
import {
  BAND_FIELDS,
  COLOR_GROUPS,
  GRADIENT_ANGLE_FIELD,
  SHADOW_FIELDS,
  SHADOW_LABELS,
  bandSeed,
  clearBandMaskColor,
  clearColor,
  clearField,
  clearShadow,
  countOverrides,
  disableDark,
  enableDark,
  gradientSeed,
  patchBand,
  patchGradient,
  patchShadow,
  setColor,
  setField,
  setShadow,
  shadowSeed,
  updateTokens,
  withTokens,
  type NumberSpec,
} from "./token-draft";

const SHADOW: Shadow = { x: 1, y: 2, blur: 3, spread: 4, color: "#112233", alpha: 0.5 };
const SHADOW_B: Shadow = { x: 0, y: 8, blur: 16, spread: 0, color: "#000000", alpha: 0.25 };

/** 八项覆盖齐全：2 色 + 2 阴影 + 圆角 + 字体 + 渐变 + 板块卡 */
const FULL: TokenSet = {
  colors: { primary: "#112233", ring: "#445566" },
  radius: "md",
  shadows: { s1: SHADOW, s2: SHADOW_B },
  displayFont: "songti",
  brandGradient: { angle: 90, from: "#000000", to: "#ffffff" },
  band: { width: 8.5, angle: 90, fade: 0, dim: 1, mask: false, maskColor: "#fffdf4" },
};

/** 对象形状要与 JSON 往返一致：不能带值为 undefined 的键 */
function expectJsonShape(value: unknown) {
  expect(value).toStrictEqual(JSON.parse(JSON.stringify(value)));
}

describe("COLOR_GROUPS", () => {
  const items = COLOR_GROUPS.flatMap((group) => group.items);

  it("22 个语义色恰好各出现一次", () => {
    expect(items).toHaveLength(COLOR_KEYS.length);
    expect(items.map((item) => item.key).sort()).toStrictEqual([...COLOR_KEYS].sort());
  });

  it("中文名非空且互不重复（按钮与输入框的可访问名称靠它区分）", () => {
    const labels = items.map((item) => item.label);
    expect(labels.every((label) => label.trim().length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("分组顺序固定", () => {
    expect(COLOR_GROUPS.map((group) => group.id)).toStrictEqual([
      "base",
      "brand",
      "status",
      "line",
    ]);
    expect(COLOR_GROUPS.every((group) => group.items.length > 0 && group.label)).toBe(true);
  });
});

describe("setColor / clearColor", () => {
  it("setColor 新增与替换，保留其他键，不改入参", () => {
    const before = structuredClone(FULL);
    const added = setColor(FULL, "card", "#abcdef");
    expect(added.colors).toStrictEqual({ primary: "#112233", ring: "#445566", card: "#abcdef" });
    expect(setColor(FULL, "primary", "#000001").colors).toStrictEqual({
      primary: "#000001",
      ring: "#445566",
    });
    expect(added.radius).toBe("md");
    expect(FULL).toStrictEqual(before);
  });

  it("setColor 在没有 colors 时创建", () => {
    expect(setColor({}, "primary", "#112233")).toStrictEqual({ colors: { primary: "#112233" } });
  });

  it("clearColor 删除该键，其余原样", () => {
    const next = clearColor(FULL, "primary");
    expect(next.colors).toStrictEqual({ ring: "#445566" });
    expect(Object.hasOwn(next.colors!, "primary")).toBe(false);
    expectJsonShape(next);
  });

  it("清掉最后一个颜色：colors 空壳一并删除，其他字段保留", () => {
    const next = clearColor({ colors: { primary: "#112233" }, radius: "md" }, "primary");
    expect(next).toStrictEqual({ radius: "md" });
    expect(Object.hasOwn(next, "colors")).toBe(false);
  });

  it("清除一个不存在的键：结果形状不变，也不凭空造出 colors", () => {
    expect(clearColor({}, "primary")).toStrictEqual({});
    expect(clearColor({ radius: "md" }, "ring")).toStrictEqual({ radius: "md" });
  });

  it("不改入参", () => {
    const before = structuredClone(FULL);
    clearColor(FULL, "primary");
    expect(FULL).toStrictEqual(before);
  });
});

describe("setShadow / clearShadow", () => {
  it("setShadow 新增与替换，保留其他档，不改入参", () => {
    const before = structuredClone(FULL);
    expect(setShadow(FULL, "s3", SHADOW).shadows).toStrictEqual({
      s1: SHADOW,
      s2: SHADOW_B,
      s3: SHADOW,
    });
    expect(setShadow(FULL, "s1", SHADOW_B).shadows).toStrictEqual({ s1: SHADOW_B, s2: SHADOW_B });
    expect(FULL).toStrictEqual(before);
  });

  it("setShadow 在没有 shadows 时创建", () => {
    expect(setShadow({}, "s2", SHADOW)).toStrictEqual({ shadows: { s2: SHADOW } });
  });

  it("clearShadow 删除该档；最后一档删掉后 shadows 空壳一并删除", () => {
    const one = clearShadow(FULL, "s1");
    expect(one.shadows).toStrictEqual({ s2: SHADOW_B });
    expectJsonShape(one);
    const none = clearShadow({ shadows: { s2: SHADOW_B }, radius: "md" }, "s2");
    expect(none).toStrictEqual({ radius: "md" });
    expect(Object.hasOwn(none, "shadows")).toBe(false);
  });

  it("清除一个不存在的档：形状不变", () => {
    expect(clearShadow({}, "s1")).toStrictEqual({});
    expect(clearShadow({ radius: "md" }, "s3")).toStrictEqual({ radius: "md" });
  });
});

describe("setField / clearField", () => {
  it("四个整体字段：设置与清除互为逆操作，且不留 undefined", () => {
    const set = setField(
      setField(
        setField(setField({}, "radius", "xl"), "displayFont", "serif"),
        "brandGradient",
        FULL.brandGradient!,
      ),
      "band",
      FULL.band!,
    );
    expect(set).toStrictEqual({
      radius: "xl",
      displayFont: "serif",
      brandGradient: FULL.brandGradient,
      band: FULL.band,
    });
    const cleared = (["radius", "displayFont", "brandGradient", "band"] as const).reduce(
      clearField,
      set,
    );
    expect(cleared).toStrictEqual({});
    expectJsonShape(cleared);
  });

  it("清除一个字段只影响它", () => {
    const next = clearField(FULL, "radius");
    expect(Object.hasOwn(next, "radius")).toBe(false);
    expect(next.colors).toBe(FULL.colors);
    expect(next.band).toBe(FULL.band);
  });

  it("不改入参", () => {
    const before = structuredClone(FULL);
    setField(FULL, "radius", "none");
    clearField(FULL, "displayFont");
    expect(FULL).toStrictEqual(before);
  });
});

describe("countOverrides", () => {
  it("每个覆盖项计一次", () => {
    expect(countOverrides(FULL)).toBe(8);
    expect(countOverrides({ colors: { primary: "#112233" } })).toBe(1);
    expect(countOverrides({ shadows: { s1: SHADOW, s2: SHADOW, s3: SHADOW } })).toBe(3);
    expect(countOverrides({ radius: "none", displayFont: "system" })).toBe(2);
  });

  it("没有令牌或没有覆盖：0", () => {
    expect(countOverrides(undefined)).toBe(0);
    expect(countOverrides({})).toBe(0);
    expect(countOverrides({ colors: {}, shadows: {} })).toBe(0);
  });

  it("不认识的键不计入", () => {
    expect(countOverrides({ colors: { bogus: "#000000" } } as unknown as TokenSet)).toBe(0);
    expect(countOverrides({ shadows: { s4: SHADOW } } as unknown as TokenSet)).toBe(0);
  });
});

describe("updateTokens", () => {
  it("从无到有：只建被编辑的那一档", () => {
    const tokens = updateTokens(undefined, "light", (set) => setColor(set, "primary", "#112233"));
    expect(tokens).toStrictEqual({ light: { colors: { primary: "#112233" } } });
    const dark = updateTokens(undefined, "dark", (set) => setField(set, "radius", "sm"));
    expect(dark).toStrictEqual({ dark: { radius: "sm" } });
  });

  it("改一档，另一档保持同一引用", () => {
    const tokens = { light: { radius: "md" as const }, dark: { radius: "xl" as const } };
    const next = updateTokens(tokens, "dark", (set) => setColor(set, "ring", "#112233"));
    expect(next?.light).toBe(tokens.light);
    expect(next?.dark).toStrictEqual({ radius: "xl", colors: { ring: "#112233" } });
    const other = updateTokens(tokens, "light", (set) => setColor(set, "ring", "#112233"));
    expect(other?.dark).toBe(tokens.dark);
  });

  it("浅色档改到没有任何覆盖：整档删除；两档都没有时整个 tokens 不存在", () => {
    const tokens = { light: { colors: { primary: "#112233" } } };
    expect(updateTokens(tokens, "light", (set) => clearColor(set, "primary"))).toBeUndefined();
    const both = { ...tokens, dark: { radius: "xl" as const } };
    const next = updateTokens(both, "light", (set) => clearColor(set, "primary"));
    expect(next).toStrictEqual({ dark: { radius: "xl" } });
    expect(Object.hasOwn(next!, "light")).toBe(false);
  });

  it("深色档改到没有任何覆盖：保留空集，表示已启用、全部继承", () => {
    const tokens = { dark: { colors: { primary: "#112233" } } };
    expect(updateTokens(tokens, "dark", (set) => clearColor(set, "primary"))).toStrictEqual({
      dark: {},
    });
  });

  it("结果形状与 JSON 往返一致，且通过 tokens schema", () => {
    let tokens = updateTokens(undefined, "light", () => FULL);
    tokens = updateTokens(tokens, "dark", (set) => setShadow(set, "s1", SHADOW));
    expectJsonShape(tokens);
    expect(tokensSchema.safeParse(tokens).success).toBe(true);
  });
});

describe("enableDark / disableDark", () => {
  it("enableDark 创建空集（全部继承），不复制浅色档的值", () => {
    expect(enableDark(undefined)).toStrictEqual({ dark: {} });
    expect(enableDark({ light: { radius: "md" } })).toStrictEqual({
      light: { radius: "md" },
      dark: {},
    });
  });

  it("enableDark 已有深色集时不动它", () => {
    const tokens = { dark: { radius: "xl" as const } };
    expect(enableDark(tokens).dark).toBe(tokens.dark);
  });

  it("disableDark 删除深色集，保留浅色档", () => {
    expect(disableDark({ light: { radius: "md" }, dark: { radius: "xl" } })).toStrictEqual({
      light: { radius: "md" },
    });
  });

  it("只有深色集时关闭 → 没有 tokens；本来就没有深色集 → 不变", () => {
    expect(disableDark({ dark: {} })).toBeUndefined();
    expect(disableDark(undefined)).toBeUndefined();
    expect(disableDark({ light: { radius: "md" } })).toStrictEqual({ light: { radius: "md" } });
  });

  it("顺手清掉空的浅色档", () => {
    expect(disableDark({ light: {}, dark: { radius: "xl" } })).toBeUndefined();
  });

  it("不改入参", () => {
    const tokens = { light: { radius: "md" as const }, dark: { radius: "xl" as const } };
    const before = structuredClone(tokens);
    disableDark(tokens);
    enableDark(tokens);
    expect(tokens).toStrictEqual(before);
  });
});

describe("withTokens", () => {
  const definition: ThemePackDefinition = {
    pwa: { themeColor: "#0e7490", backgroundColor: "#f8fafc" },
    surfaces: { header: { light: {} } },
    tokens: { light: { radius: "md" } },
  };

  it("写入新的 tokens，其他段原样", () => {
    const next = withTokens(definition, { dark: {} });
    expect(next).toStrictEqual({ ...definition, tokens: { dark: {} } });
    expect(next.surfaces).toBe(definition.surfaces);
  });

  it("传 undefined 会删掉原有的 tokens 键，而不是留着旧值", () => {
    const next = withTokens(definition, undefined);
    expect(Object.hasOwn(next, "tokens")).toBe(false);
    expect(next).toStrictEqual({ pwa: definition.pwa, surfaces: definition.surfaces });
    expectJsonShape(next);
  });

  it("原本就没有 tokens 且传 undefined：不凭空出现", () => {
    expect(withTokens({ surfaces: {} }, undefined)).toStrictEqual({ surfaces: {} });
  });

  it("不改入参", () => {
    const before = structuredClone(definition);
    withTokens(definition, undefined);
    withTokens(definition, { dark: {} });
    expect(definition).toStrictEqual(before);
  });
});

describe("起点值", () => {
  it("shadowSeed 与基础层同值、是副本、通过 schema", () => {
    for (const mode of ["light", "dark"] as const) {
      for (const slot of SHADOW_SLOTS) {
        const seed = shadowSeed(mode, slot);
        expect(seed).toStrictEqual(BASE_SHADOWS[mode][slot]);
        expect(seed).not.toBe(BASE_SHADOWS[mode][slot]);
        expect(shadowSchema.safeParse(seed).success).toBe(true);
      }
    }
    const seed = shadowSeed("light", "s1");
    seed.x = 99;
    expect(BASE_SHADOWS.light.s1.x).toBe(0);
  });

  it("bandSeed 与基础层同值、是副本、不含遮罩色、通过 schema", () => {
    const seed = bandSeed();
    expect(seed).toStrictEqual(BASE_BAND);
    expect(seed).not.toBe(BASE_BAND);
    expect(Object.hasOwn(seed, "maskColor")).toBe(false);
    expect(bandSchema.safeParse(seed).success).toBe(true);
    seed.width = 1;
    expect(BASE_BAND.width).toBe(7);
  });

  it("gradientSeed：135°，主色 → 强调底，取当前这一档生效的颜色", () => {
    expect(gradientSeed("light", undefined)).toStrictEqual({
      angle: 135,
      from: "#0e7490",
      to: "#ecfeff",
    });
    expect(gradientSeed("dark", undefined)).toStrictEqual({
      angle: 135,
      from: "#22d3ee",
      to: "#083344",
    });
  });

  it("gradientSeed 跟随本档的覆盖（规范化为小写），忽略不合法的值", () => {
    expect(gradientSeed("light", { primary: "#ABCDEF", accent: "#123456" })).toStrictEqual({
      angle: 135,
      from: "#abcdef",
      to: "#123456",
    });
    expect(gradientSeed("light", { primary: "红" }).from).toBe("#0e7490");
    expect(tokenSetSchema.safeParse({ brandGradient: gradientSeed("dark", {}) }).success).toBe(
      true,
    );
  });
});

describe("patchShadow", () => {
  it("该档还没有覆盖：以本档基础层起点为底，只改被改的字段", () => {
    const light = patchShadow({}, "light", "s2", { blur: 20 });
    expect(light.shadows?.s2).toStrictEqual({ ...BASE_SHADOWS.light.s2, blur: 20 });
    const dark = patchShadow({}, "dark", "s2", { blur: 20 });
    expect(dark.shadows?.s2).toStrictEqual({ ...BASE_SHADOWS.dark.s2, blur: 20 });
  });

  it("该档已有覆盖：以现值为底，其余字段保留（不回到起点）", () => {
    const next = patchShadow(FULL, "light", "s1", { alpha: 0.9 });
    expect(next.shadows?.s1).toStrictEqual({ ...SHADOW, alpha: 0.9 });
  });

  it("只动这一档：其他档与其他字段保持同一引用", () => {
    const next = patchShadow(FULL, "light", "s1", { x: 5 });
    expect(next.shadows?.s2).toBe(FULL.shadows?.s2);
    expect(next.colors).toBe(FULL.colors);
    expect(next.band).toBe(FULL.band);
  });

  it("结果通过 schema，且不改入参、不留 undefined", () => {
    const before = structuredClone(FULL);
    const next = patchShadow(FULL, "dark", "s3", { color: "#ABCDEF".toLowerCase() });
    expect(shadowSchema.safeParse(next.shadows?.s3).success).toBe(true);
    expect(FULL).toStrictEqual(before);
    expectJsonShape(next);
  });
});

describe("patchGradient", () => {
  it("还没有覆盖：以协调的默认起点为底，起点取本档生效的颜色", () => {
    expect(patchGradient({}, "light", { angle: 45 }).brandGradient).toStrictEqual({
      angle: 45,
      from: "#0e7490",
      to: "#ecfeff",
    });
    const withColors = patchGradient({ colors: { primary: "#123456" } }, "light", { angle: 45 });
    expect(withColors.brandGradient?.from).toBe("#123456");
    expect(patchGradient({}, "dark", { angle: 45 }).brandGradient?.from).toBe("#22d3ee");
  });

  it("已有覆盖：以现值为底，其余字段保留", () => {
    const next = patchGradient(FULL, "light", { to: "#abcdef" });
    expect(next.brandGradient).toStrictEqual({ angle: 90, from: "#000000", to: "#abcdef" });
    expect(next.colors).toBe(FULL.colors);
  });

  it("不改入参", () => {
    const before = structuredClone(FULL);
    patchGradient(FULL, "light", { angle: 1 });
    expect(FULL).toStrictEqual(before);
  });
});

describe("patchBand / clearBandMaskColor", () => {
  it("还没有覆盖：以基础层起点为底（含 dim，不含遮罩色）", () => {
    const next = patchBand({}, { width: 9 });
    expect(next.band).toStrictEqual({ ...BASE_BAND, width: 9 });
    expect(bandSchema.safeParse(next.band).success).toBe(true);
  });

  it("已有覆盖：只改指定字段，dim 与遮罩色原样保留", () => {
    const next = patchBand(FULL, { width: 10 });
    expect(next.band).toStrictEqual({ ...FULL.band, width: 10 });
    expect(next.band?.dim).toBe(1);
    expect(next.band?.maskColor).toBe("#fffdf4");
  });

  it("可以设置遮罩色与遮罩开关", () => {
    const next = patchBand(patchBand({}, { maskColor: "#ffffff" }), { mask: false });
    expect(next.band).toStrictEqual({ ...BASE_BAND, mask: false, maskColor: "#ffffff" });
  });

  it("clearBandMaskColor：删除遮罩色这个键（不是写 undefined），其余字段保留", () => {
    const next = clearBandMaskColor(FULL);
    expect(Object.hasOwn(next.band!, "maskColor")).toBe(false);
    expect(next.band).toStrictEqual({ width: 8.5, angle: 90, fade: 0, dim: 1, mask: false });
    expect(next.colors).toBe(FULL.colors);
    expectJsonShape(next);
  });

  it("clearBandMaskColor：没有板块卡覆盖时原样返回；板块卡本来就没有遮罩色时形状不变", () => {
    const empty: TokenSet = { radius: "md" };
    expect(clearBandMaskColor(empty)).toBe(empty);
    const plain = patchBand({}, { width: 9 });
    expect(clearBandMaskColor(plain)).toStrictEqual(plain);
  });

  it("不改入参", () => {
    const before = structuredClone(FULL);
    patchBand(FULL, { fade: 5 });
    clearBandMaskColor(FULL);
    expect(FULL).toStrictEqual(before);
  });
});

describe("字段规格与 token-schema 一致", () => {
  /** 边界与边界外一步、内一步，以及小数探针（整数字段应拒绝、两位小数字段应拒绝第三位） */
  function probes(spec: NumberSpec<string>): number[] {
    const step = spec.integer ? 1 : 0.01;
    return [
      spec.min,
      spec.max,
      spec.min - step,
      spec.max + step,
      spec.min + step,
      spec.max - step,
      spec.min + 0.5,
      spec.min + 0.005,
    ];
  }

  type Schema = { safeParse: (value: unknown) => { success: boolean } };
  const cases: {
    name: string;
    spec: NumberSpec<string>;
    schema: Schema;
    build: (n: number) => unknown;
  }[] = [
    ...SHADOW_FIELDS.map((spec) => ({
      name: `阴影.${spec.key}`,
      spec,
      schema: shadowSchema,
      build: (n: number) => ({ ...BASE_SHADOWS.light.s1, [spec.key]: n }),
    })),
    ...BAND_FIELDS.map((spec) => ({
      name: `板块卡.${spec.key}`,
      spec,
      schema: bandSchema,
      build: (n: number) => ({ ...BASE_BAND, [spec.key]: n }),
    })),
    {
      name: "品牌渐变.angle",
      spec: GRADIENT_ANGLE_FIELD,
      schema: tokenSetSchema,
      build: (n: number) => ({ brandGradient: { angle: n, from: "#000000", to: "#ffffff" } }),
    },
  ];

  it.each(cases)("$name：编辑器接受什么，schema 就接受什么", ({ spec, schema, build }) => {
    for (const probe of probes(spec)) {
      const accepted = parseBounded(String(probe), spec) !== null;
      expect(accepted, `探针 ${probe}`).toBe(schema.safeParse(build(probe)).success);
    }
  });

  it("阴影字段覆盖 schema 里除颜色外的全部键", () => {
    const keys = Object.keys(shadowSchema.shape).filter((key) => key !== "color");
    expect(SHADOW_FIELDS.map((spec) => spec.key).sort()).toStrictEqual(keys.sort());
  });

  it("板块卡只开放宽度、角度、渐隐宽度三项数字（dim 目前无组件消费，不提供控件）", () => {
    expect(BAND_FIELDS.map((spec) => spec.key)).toStrictEqual(["width", "angle", "fade"]);
    expect(Object.keys(bandSchema.shape)).toContain("dim");
  });

  it("同一组里的中文名互不重复；阴影三档名称互不重复", () => {
    for (const list of [SHADOW_FIELDS, BAND_FIELDS]) {
      const labels = list.map((spec) => spec.label);
      expect(new Set(labels).size).toBe(labels.length);
    }
    expect(new Set(Object.values(SHADOW_LABELS)).size).toBe(SHADOW_SLOTS.length);
  });
});
