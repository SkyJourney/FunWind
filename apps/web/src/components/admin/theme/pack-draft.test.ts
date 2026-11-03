import { describe, expect, it } from "vitest";
import type { ThemePackDefinition } from "@/lib/theme/surface-schema";
import type { SurfaceMeta } from "@/components/admin/theme-pack-editor";
import {
  DEFAULT_PWA,
  defaultOverlayGradient,
  definitionFromDraft,
  toDraft,
  updateContentSlot,
  updateDraftCapability,
  type SurfaceDraft,
} from "./pack-draft";

const surfaces: readonly SurfaceMeta[] = [
  { id: "header", label: "顶栏", caps: ["fill", "overlay", "contentSlot"] },
  { id: "footer", label: "页脚", caps: ["fill"] },
];

const definition: ThemePackDefinition = {
  pwa: { themeColor: "#123456", backgroundColor: "#abcdef" },
  surfaces: {
    header: {
      light: { fill: { type: "solid", color: "#ffffff" }, blur: 3 },
      dark: { fill: { type: "solid", color: "#000000" } },
    },
    page: { light: { blur: 2 } },
  },
};

describe("主题包草稿转换", () => {
  it("按传入区域建立浅深档草稿，缺省区域只建立空浅色档", () => {
    const draft = toDraft(definition, surfaces);
    expect(Object.keys(draft)).toEqual(["header", "footer"]);
    expect(draft.header).toEqual(definition.surfaces.header);
    expect(draft.footer).toEqual({ light: {} });
    expect(draft.footer).not.toHaveProperty("dark");
    expect(toDraft(definition, [])).toEqual({});
  });

  it("复制能力容器而非改写原定义，保留未编辑的嵌套能力", () => {
    const draft = toDraft(definition, surfaces);
    expect(draft.header.light).not.toBe(definition.surfaces.header.light);
    expect(draft.header.dark).not.toBe(definition.surfaces.header.dark);
    expect(draft.header.light.fill).toBe(definition.surfaces.header.light.fill);
    draft.header.light.blur = 12;
    expect(definition.surfaces.header.light.blur).toBe(3);
  });

  it("保留显式空深色档，不把浅色定义复制为深色", () => {
    const draft = toDraft({ surfaces: { header: { light: { blur: 4 }, dark: {} } } }, surfaces);
    expect(draft.header.dark).toEqual({});
    expect(draft.header.dark).not.toBe(draft.header.light);
  });

  it("省略全空区域和空深色档，但保留仅深色有内容的区域", () => {
    const draft: Record<string, SurfaceDraft> = {
      header: { light: { blur: 0 }, dark: {} },
      footer: { light: {}, dark: { blur: 5 } },
      page: { light: {}, dark: {} },
      auth: { light: {} },
    };
    expect(definitionFromDraft(draft, DEFAULT_PWA)).toEqual({
      pwa: DEFAULT_PWA,
      surfaces: {
        header: { light: { blur: 0 } },
        footer: { light: {}, dark: { blur: 5 } },
      },
    });
  });

  it("保持原有 undefined 键及 JSON 序列化口径，不额外清理能力", () => {
    const draft: Record<string, SurfaceDraft> = {
      header: { light: { overlay: undefined }, dark: { fill: undefined } },
    };
    const result = definitionFromDraft(draft, DEFAULT_PWA);
    expect(result.surfaces.header.light).toHaveProperty("overlay", undefined);
    expect(result.surfaces.header.dark).toHaveProperty("fill", undefined);
    expect(JSON.parse(JSON.stringify(result))).toEqual({
      pwa: DEFAULT_PWA,
      surfaces: { header: { light: {}, dark: {} } },
    });
  });

  it("转换保留 PWA 与未修改能力的引用，支持默认 PWA", () => {
    const draft = toDraft(definition, surfaces);
    const pwa = definition.pwa!;
    const result = definitionFromDraft(draft, pwa);
    expect(result.pwa).toBe(pwa);
    expect(result.surfaces.header.light).toBe(draft.header.light);
    expect(result.surfaces.header.dark).toBe(draft.header.dark);
    expect(DEFAULT_PWA).toEqual({ themeColor: "#0e7490", backgroundColor: "#f8fafc" });
  });
});

describe("主题包草稿不可变更新", () => {
  it.each(["light", "dark"] as const)("只更新指定区域的 %s 档能力", (mode) => {
    const draft = toDraft(definition, surfaces);
    const before = structuredClone(draft);
    const otherMode = mode === "light" ? "dark" : "light";
    Object.freeze(draft.header[mode]);
    Object.freeze(draft.header);
    Object.freeze(draft);
    const updated = updateDraftCapability(draft, "header", mode, "blur", 8);
    expect(updated).not.toBe(draft);
    expect(updated.header).not.toBe(draft.header);
    expect(updated.header[mode]).toEqual({ ...draft.header[mode], blur: 8 });
    expect(updated.header[otherMode]).toBe(draft.header[otherMode]);
    expect(updated.footer).toBe(draft.footer);
    expect(draft).toEqual(before);
  });

  it("更新缺省区域或深色档时建立必要容器，不添加浅色回退能力", () => {
    const dark = updateDraftCapability({}, "header", "dark", "blur", 1);
    expect(dark).toEqual({ header: { light: {}, dark: { blur: 1 } } });
    expect(updateDraftCapability({}, "header", "light", "blur", 2)).toEqual({
      header: { light: { blur: 2 } },
    });
    const draft = { header: { light: { blur: 4 } } };
    expect(updateDraftCapability(draft, "header", "dark", "blur", 3)).toEqual({
      header: { light: { blur: 4 }, dark: { blur: 3 } },
    });
  });

  it("清空能力时保留 undefined 键，不移除同档其他能力", () => {
    const draft = toDraft(definition, surfaces);
    expect(updateDraftCapability(draft, "header", "light", "fill", undefined).header.light).toEqual(
      {
        fill: undefined,
        blur: 3,
      },
    );
  });

  it("内容插槽合并补丁，不改写已有图片、高度和文字设置", () => {
    const current = Object.freeze({ image: "decor.png", imageHeightPx: 320, hideText: true });
    expect(updateContentSlot(current, { hideText: false })).toEqual({
      image: "decor.png",
      imageHeightPx: 320,
      hideText: false,
    });
    expect(current.hideText).toBe(true);
  });

  it("只有空插槽被移除，显式 false 或高度单独存在时仍保留", () => {
    expect(updateContentSlot(undefined, {})).toBeUndefined();
    expect(updateContentSlot({ image: "decor.png" }, { image: undefined })).toBeUndefined();
    expect(updateContentSlot(undefined, { hideText: false })).toEqual({ hideText: false });
    expect(
      updateContentSlot({ image: "decor.png", imageHeightPx: 240 }, { image: undefined }),
    ).toEqual({
      image: undefined,
      imageHeightPx: 240,
    });
  });
});

describe("默认遮罩渐变", () => {
  it.each([
    ["linear", { angle: 105 }],
    ["radial", { shape: "ellipse" }],
  ] as const)("%s 保持默认参数，且各次创建的色标互不共享", (type, geometry) => {
    const gradient = defaultOverlayGradient(type);
    expect(gradient).toEqual({
      type,
      ...geometry,
      overlayOpacity: 1,
      stops: [
        { color: "#ffffff", alpha: 0, position: 0 },
        { color: "#ffffff", alpha: 1, position: 100 },
      ],
    });
    if (gradient.type !== "linear" && gradient.type !== "radial") throw new Error("应为渐变");
    gradient.stops[0].alpha = 0.5;
    expect(defaultOverlayGradient(type)).not.toEqual(gradient);
  });
});
