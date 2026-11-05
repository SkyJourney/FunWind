import { describe, expect, it } from "vitest";
import {
  definitionForThemePackControls,
  definitionForThemePackPreview,
  parseThemePackSaveDraft,
  serializeThemePackSaveDraft,
  themePackSaveDraftKey,
  type ThemePackSaveDraft,
} from "./pack-save-draft";

const draft: ThemePackSaveDraft = {
  userId: 7,
  packId: "test",
  expectedRevision: 4,
  name: "未保存名称",
  description: "未保存说明",
  definition: {
    surfaces: { header: { light: {}, dark: { fill: { type: "solid", color: "#123456" } } } },
  },
};

describe("主题保存快照编解码", () => {
  it("存储键同时隔离账号与主题包", () => {
    expect(themePackSaveDraftKey(7, "test")).toBe("fw.theme-pack.draft.7.test");
    expect(themePackSaveDraftKey(7, "test")).not.toBe(themePackSaveDraftKey(8, "test"));
    expect(themePackSaveDraftKey(7, "test")).not.toBe(themePackSaveDraftKey(7, "other"));
  });

  it("往返保留定义、名称、说明和草稿所属原版本", () => {
    expect(parseThemePackSaveDraft(serializeThemePackSaveDraft(draft))).toEqual(draft);
  });

  it("空名称与说明仍可暂存，避免校验失败时丢掉输入", () => {
    const empty = { ...draft, name: "", description: "" };
    expect(parseThemePackSaveDraft(JSON.stringify(empty))).toEqual(empty);
  });

  it.each([
    { type: "linear", angle: 90, stops: null },
    { type: "radial", shape: "circle", stops: [null] },
    {
      type: "image",
      asset: null,
      position: "50% 50%",
      size: "cover",
      repeat: "no-repeat",
      blend: "normal",
      opacity: 1,
    },
  ])("损坏的渐变/图片对象结构不作为可恢复草稿：%j", (fill) => {
    expect(
      parseThemePackSaveDraft(
        JSON.stringify({ ...draft, definition: { surfaces: { header: { light: { fill } } } } }),
      ),
    ).toBeNull();
  });

  it("NaN 序列化为 null 后原始定义保留，控件副本回退数值，预览仍隔离", () => {
    const invalid = { ...draft, definition: { surfaces: { header: { light: { blur: null } } } } };
    const restored = parseThemePackSaveDraft(JSON.stringify(invalid));
    expect(restored?.definition).toEqual(invalid.definition);
    expect(definitionForThemePackControls(restored!.definition).surfaces.header.light.blur).toBe(0);
    expect(definitionForThemePackPreview(restored!.definition)).toEqual({ surfaces: {} });
  });

  it("schema 暂时无效与未知字段无损保留，预览拒绝未知 CSS 和非法资源", () => {
    const intermediate = {
      ...draft,
      definition: {
        surfaces: {
          header: {
            light: {
              fill: {
                type: "image",
                asset: "",
                opacity: 2,
                position: "50% 50%",
                size: "cover",
                repeat: "no-repeat",
                blend: "normal",
              },
              blur: 99,
            },
          },
        },
        unknown: "background: url(https://invalid.test)",
      },
    };
    const restored = parseThemePackSaveDraft(JSON.stringify(intermediate));
    expect(restored).toEqual(intermediate);
    expect(definitionForThemePackPreview(restored!.definition)).toEqual({ surfaces: {} });
  });

  describe("语义令牌", () => {
    const tokens = {
      light: {
        colors: { primary: "#112233" },
        radius: "md",
        shadows: { s1: { x: 1, y: 2, blur: 3, spread: 0, color: "#000000", alpha: 0.25 } },
        brandGradient: { angle: 90, from: "#000000", to: "#ffffff" },
        band: { width: 8.5, angle: 90, fade: 0, dim: 1, mask: false },
      },
      dark: {},
    };
    const withTokens = (value: unknown) => ({
      ...draft,
      definition: { ...draft.definition, tokens: value },
    });

    it("合法的令牌随草稿往返，预览也保留它们", () => {
      const withValid = withTokens(tokens);
      const restored = parseThemePackSaveDraft(JSON.stringify(withValid));
      expect(restored).toEqual(withValid);
      expect(restored?.definition.tokens).toEqual(tokens);
      expect(definitionForThemePackPreview(restored!.definition).tokens).toEqual(tokens);
    });

    it("没有令牌的草稿不受影响", () => {
      expect(parseThemePackSaveDraft(JSON.stringify(draft))).toEqual(draft);
    });

    it.each([
      ["不是对象", "abc"],
      ["null", null],
      ["数组", []],
      ["颜色不是 #RRGGBB", { light: { colors: { primary: "red" } } }],
      ["圆角档位不存在", { light: { radius: "huge" } }],
      ["阴影缺字段", { light: { shadows: { s1: { x: 1 } } } }],
      [
        "阴影越界",
        {
          light: {
            shadows: { s1: { x: 999, y: 0, blur: 0, spread: 0, color: "#000000", alpha: 0.5 } },
          },
        },
      ],
      [
        "NaN 序列化成的 null（不会被悄悄当成 0）",
        {
          light: {
            shadows: { s1: { x: null, y: 0, blur: 0, spread: 0, color: "#000000", alpha: 0.5 } },
          },
        },
      ],
      ["板块卡缺遮罩开关", { dark: { band: { width: 7, angle: 105, fade: 50, dim: 0.85 } } }],
      ["令牌集里有未知字段", { light: { unknownField: 1 } }],
      ["令牌段里有未知字段", { light: {}, extra: 1 }],
    ])("令牌不合 schema：整份草稿按损坏处理（%s）", (_name, bad) => {
      expect(parseThemePackSaveDraft(JSON.stringify(withTokens(bad)))).toBeNull();
    });

    it("令牌损坏时，哪怕区域设置完好，也不恢复半份草稿", () => {
      const bad = withTokens({ light: { radius: "huge" } });
      expect(bad.definition.surfaces).toEqual(draft.definition.surfaces);
      expect(parseThemePackSaveDraft(JSON.stringify(bad))).toBeNull();
    });
  });

  it.each([
    "{不完整JSON",
    "null",
    "42",
    "[]",
    JSON.stringify(draft.definition),
    JSON.stringify({ ...draft, expectedRevision: undefined }),
    JSON.stringify({ ...draft, expectedRevision: 0 }),
    JSON.stringify({ ...draft, expectedRevision: 1.5 }),
    JSON.stringify({ ...draft, expectedRevision: "4" }),
    JSON.stringify({ ...draft, userId: "7" }),
    JSON.stringify({ ...draft, packId: undefined }),
    JSON.stringify({ ...draft, name: "x".repeat(61) }),
    JSON.stringify({ ...draft, description: "x".repeat(201) }),
    JSON.stringify({ ...draft, definition: [] }),
  ])("坏档或不完整快照不恢复：%s", (raw) => {
    expect(parseThemePackSaveDraft(raw)).toBeNull();
  });
});
