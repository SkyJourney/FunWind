import { describe, expect, it } from "vitest";
import { FULL_TOKENS } from "@/test/theme-token-fixture";
import { remapDefinitionAssets } from "./remap-definition";
import type { ThemePackDefinition } from "./surface-schema";

describe("remap-definition", () => {
  it("重映射 fill image 素材", () => {
    const def: ThemePackDefinition = {
      surfaces: {
        header: {
          light: {
            fill: {
              type: "image",
              asset: "decor-old.png",
              position: "center",
              size: "cover",
              repeat: "no-repeat",
              blend: "normal",
              opacity: 1,
            },
          },
        },
      },
    };
    const fileMap = new Map([["decor-old.png", "decor-new.png"]]);
    const result = remapDefinitionAssets(def, fileMap);
    const fill = result.surfaces.header.light.fill as Record<string, unknown>;
    expect(fill.asset).toBe("decor-new.png");
  });

  it("重映射 overlay image 素材", () => {
    const def: ThemePackDefinition = {
      surfaces: {
        page: {
          light: {
            overlay: {
              type: "image",
              asset: "decor-a.png",
              position: "center",
              size: "cover",
              repeat: "no-repeat",
              blend: "normal",
              opacity: 0.5,
            },
          },
        },
      },
    };
    const fileMap = new Map([["decor-a.png", "decor-b.png"]]);
    const result = remapDefinitionAssets(def, fileMap);
    const overlay = result.surfaces.page.light.overlay as Record<string, unknown>;
    expect(overlay.asset).toBe("decor-b.png");
  });

  it("重映射 contentSlot image", () => {
    const def: ThemePackDefinition = {
      surfaces: {
        header: {
          light: { contentSlot: { image: "decor-x.png" } },
        },
      },
    };
    const fileMap = new Map([["decor-x.png", "decor-y.png"]]);
    const result = remapDefinitionAssets(def, fileMap);
    expect(result.surfaces.header.light.contentSlot?.image).toBe("decor-y.png");
  });

  it("保留 pwa 段", () => {
    const def: ThemePackDefinition = {
      pwa: { themeColor: "#147ba9", backgroundColor: "#f6f3e7" },
      surfaces: {},
    };
    const result = remapDefinitionAssets(def, new Map());
    expect(result.pwa).toEqual({ themeColor: "#147ba9", backgroundColor: "#f6f3e7" });
  });

  it("保留 tokens 段", () => {
    const def: ThemePackDefinition = {
      surfaces: {},
      tokens: { light: { colors: { primary: "#147ba9" } } },
    };
    const result = remapDefinitionAssets(def, new Map());
    expect(result.tokens).toEqual({ light: { colors: { primary: "#147ba9" } } });
  });

  it("素材被改写的同时，完整 tokens（浅深两档）与 pwa 原样保留", () => {
    const def: ThemePackDefinition = {
      pwa: { themeColor: "#147ba9", backgroundColor: "#f6f3e7" },
      tokens: FULL_TOKENS,
      surfaces: {
        header: {
          light: {
            fill: {
              type: "image",
              asset: "decor-old.png",
              position: "center",
              size: "cover",
              repeat: "no-repeat",
              blend: "normal",
              opacity: 1,
            },
          },
        },
      },
    };
    const result = remapDefinitionAssets(def, new Map([["decor-old.png", "decor-new.png"]]));
    expect((result.surfaces.header.light.fill as Record<string, unknown>).asset).toBe(
      "decor-new.png",
    );
    expect(result.tokens).toEqual(FULL_TOKENS);
    expect(result.pwa).toEqual(def.pwa);
  });

  it("未映射的素材保持原样", () => {
    const def: ThemePackDefinition = {
      surfaces: {
        header: {
          light: {
            fill: {
              type: "image",
              asset: "decor-unchanged.png",
              position: "center",
              size: "cover",
              repeat: "no-repeat",
              blend: "normal",
              opacity: 1,
            },
          },
        },
      },
    };
    const result = remapDefinitionAssets(def, new Map());
    const fill = result.surfaces.header.light.fill as Record<string, unknown>;
    expect(fill.asset).toBe("decor-unchanged.png");
  });

  it("非 image 类型的 fill 不受影响", () => {
    const def: ThemePackDefinition = {
      surfaces: {
        header: {
          light: { fill: { type: "solid", color: "#ffffff" } },
        },
      },
    };
    const result = remapDefinitionAssets(def, new Map());
    expect(result.surfaces.header.light.fill).toEqual({ type: "solid", color: "#ffffff" });
  });
});
