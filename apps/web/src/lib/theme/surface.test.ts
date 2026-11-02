import { describe, expect, it } from "vitest";
import { parseThemePackDefinition, type ThemePackDefinition } from "./surface-schema";
import {
  cssTextForPack,
  renderPackCssVars,
  renderSurfaceEntry,
  renderSurfaceVars,
} from "./surface-render";

const VALID: ThemePackDefinition = {
  surfaces: {
    header: {
      light: {
        fill: { type: "solid", color: "#112233" },
        blur: 8,
        border: { color: "#445566", width: 1, style: "solid" },
        text: { primary: "#ffffff", muted: "#cccccc", link: "#00aaaa" },
      },
      dark: {
        fill: {
          type: "linear",
          angle: 90,
          stops: [
            { color: "#000000", alpha: 0.8, position: 0 },
            { color: "#222222", alpha: 1, position: 100 },
          ],
        },
      },
    },
    page: {
      light: {
        fill: {
          type: "radial",
          shape: "ellipse",
          stops: [
            { color: "#111111", alpha: 1, position: 0 },
            { color: "#eeeeee", alpha: 0.4, position: 100 },
          ],
        },
      },
    },
    "forum-band": {
      light: {
        fill: {
          type: "image",
          asset: "decor-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
          position: "50% 50%",
          size: "cover",
          repeat: "no-repeat",
          blend: "soft-light",
          opacity: 0.7,
        },
        overlay: {
          type: "linear",
          angle: 105,
          stops: [
            { color: "#ffffff", alpha: 0, position: 0 },
            { color: "#ffffff", alpha: 1, position: 100 },
          ],
          overlayOpacity: 0.9,
        },
      },
    },
  },
};

const rejected = (raw: unknown) => {
  const r = parseThemePackDefinition(raw);
  expect(r.ok).toBe(false);
  if (!r.ok) return r.errors;
  throw new Error("unreachable");
};

describe("parseThemePackDefinition（Surface schema 白名单）", () => {
  it("合法定义通过且保留结构", () => {
    const r = parseThemePackDefinition(VALID);
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.value.surfaces.header?.light.fill).toEqual({ type: "solid", color: "#112233" });
  });

  it("非法颜色 / rgba / css 函数拒绝", () => {
    expect(
      rejected({ surfaces: { page: { light: { fill: { type: "solid", color: "red" } } } } }),
    ).toHaveLength(1);
    expect(
      rejected({ surfaces: { page: { light: { fill: { type: "solid", color: "#11223" } } } } }),
    ).toHaveLength(1);
    expect(
      rejected({
        surfaces: { page: { light: { fill: { type: "solid", color: "rgba(1,2,3,0.5)" } } } },
      }),
    ).toHaveLength(1);
    expect(
      rejected({ surfaces: { page: { light: { fill: { type: "solid", color: "var(--x)" } } } } }),
    ).toHaveLength(1);
  });

  it("渐变色标少于 2 / 越界角度 / 越界 alpha-position 拒绝", () => {
    expect(
      rejected({
        surfaces: {
          page: {
            light: {
              fill: {
                type: "linear",
                angle: 0,
                stops: [{ color: "#111111", alpha: 1, position: 0 }],
              },
            },
          },
        },
      }),
    ).toHaveLength(1);
    expect(
      rejected({
        surfaces: {
          page: {
            light: {
              fill: {
                type: "linear",
                angle: 400,
                stops: [
                  { color: "#111111", alpha: 1, position: 0 },
                  { color: "#222222", alpha: 1, position: 100 },
                ],
              },
            },
          },
        },
      }),
    ).toHaveLength(1);
    expect(
      rejected({
        surfaces: {
          page: {
            light: {
              fill: {
                type: "radial",
                shape: "circle",
                stops: [
                  { color: "#111111", alpha: 1.5, position: 0 },
                  { color: "#222222", alpha: 1, position: 100 },
                ],
              },
            },
          },
        },
      }),
    ).toHaveLength(1);
    expect(
      rejected({
        surfaces: {
          page: {
            light: {
              fill: {
                type: "radial",
                shape: "circle",
                stops: [
                  { color: "#111111", alpha: 1, position: -5 },
                  { color: "#222222", alpha: 1, position: 100 },
                ],
              },
            },
          },
        },
      }),
    ).toHaveLength(1);
    expect(
      rejected({
        surfaces: {
          page: {
            light: {
              fill: {
                type: "linear",
                angle: 90,
                stops: [
                  { color: "#111111", alpha: 0.123, position: 0 },
                  { color: "#222222", alpha: 1, position: 100 },
                ],
              },
            },
          },
        },
      }),
    ).toHaveLength(1);
  });

  it("图片填充：未知字段 / 非法 position / 非枚举 blend / 越界 opacity 拒绝；url 与 data: 在 asset 值外无法注入", () => {
    expect(
      rejected({
        surfaces: {
          "forum-band": {
            light: {
              fill: {
                type: "image",
                asset: "decor-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
                position: "50% 50%",
                size: "cover",
                repeat: "no-repeat",
                blend: "normal",
                opacity: 1,
                css: "evil",
              },
            },
          },
        },
      }),
    ).toHaveLength(1);
    expect(
      rejected({
        surfaces: {
          "forum-band": {
            light: {
              fill: {
                type: "image",
                asset: "decor-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
                position: "left right",
                size: "cover",
                repeat: "no-repeat",
                blend: "normal",
                opacity: 1,
              },
            },
          },
        },
      }),
    ).toHaveLength(1);
    expect(
      rejected({
        surfaces: {
          "forum-band": {
            light: {
              fill: {
                type: "image",
                asset: "decor-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
                position: "50% 50%",
                size: "cover",
                repeat: "diagonal",
                blend: "normal",
                opacity: 1,
              },
            },
          },
        },
      }),
    ).toHaveLength(1);
    expect(
      rejected({
        surfaces: {
          "forum-band": {
            light: {
              fill: {
                type: "image",
                asset: "decor-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
                position: "50% 50%",
                size: "cover",
                repeat: "no-repeat",
                blend: "normal",
                opacity: 3,
              },
            },
          },
        },
      }),
    ).toHaveLength(1);
  });

  it("图片尺寸百分比必须在 1–100 之间", () => {
    expect(
      rejected({
        surfaces: {
          "forum-band": {
            light: {
              fill: {
                type: "image",
                asset: "decor-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
                position: "50% 50%",
                size: "0%",
                repeat: "no-repeat",
                blend: "normal",
                opacity: 1,
              },
            },
          },
        },
      }),
    ).toHaveLength(1);
  });

  it("图片资源格式、安全位置组合与百分比边界受限", () => {
    expect(
      rejected({
        surfaces: {
          "forum-band": {
            light: {
              fill: {
                type: "image",
                asset: "https://example.com/a.png",
                position: "top left",
                size: "cover",
                repeat: "no-repeat",
                blend: "normal",
                opacity: 1,
              },
            },
          },
        },
      }),
    ).toHaveLength(1);
    expect(
      parseThemePackDefinition({
        surfaces: {
          "forum-band": {
            light: {
              fill: {
                type: "image",
                asset: "decor-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
                position: "top left",
                size: "cover",
                repeat: "no-repeat",
                blend: "normal",
                opacity: 1,
              },
            },
          },
        },
      }).ok,
    ).toBe(true);
    expect(
      rejected({
        surfaces: {
          "forum-band": {
            light: {
              fill: {
                type: "image",
                asset: "decor-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
                position: "101% 50%",
                size: "cover",
                repeat: "no-repeat",
                blend: "normal",
                opacity: 1,
              },
            },
          },
        },
      }),
    ).toHaveLength(1);
  });

  it("区域 capability 白名单阻止不支持的字段，允许注册的 contentSlot", () => {
    expect(
      rejected({
        surfaces: { page: { light: { border: { color: "#111111", width: 1, style: "solid" } } } },
      }),
    ).toHaveLength(1);
    expect(
      parseThemePackDefinition({
        surfaces: {
          header: {
            light: {
              contentSlot: {
                image: "decor-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
                imageHeightPx: 240,
                hideText: true,
              },
            },
          },
        },
      }).ok,
    ).toBe(true);
    expect(
      rejected({ surfaces: { page: { light: { contentSlot: { hideText: true } } } } }),
    ).toHaveLength(1);
  });

  it("blur 越界 / border 非法 width / 未知字段（strict）拒绝", () => {
    expect(rejected({ surfaces: { header: { light: { blur: 30 } } } })).toHaveLength(1);
    expect(
      rejected({
        surfaces: { header: { light: { border: { color: "#111111", width: 5, style: "solid" } } } },
      }),
    ).toHaveLength(1);
    expect(rejected({ surfaces: { header: { light: { evil: "x" } } } })).toHaveLength(1);
    expect(rejected({ surfaces: { evilArea: { light: {} } } })).toHaveLength(1);
    expect(rejected({ surfaces: {}, evilTop: 1 })).toHaveLength(1);
  });

  it("PWA 颜色只允许严格 hex，并拒绝未知元数据字段", () => {
    expect(
      parseThemePackDefinition({
        surfaces: {},
        pwa: { themeColor: "#123456", backgroundColor: "#f0f0f0" },
      }),
    ).toMatchObject({ ok: true, value: { pwa: { themeColor: "#123456" } } });
    expect(
      rejected({
        surfaces: {},
        pwa: { themeColor: "rgba(1,2,3,1)", backgroundColor: "#f0f0f0" },
      }),
    ).toHaveLength(1);
    expect(
      rejected({
        surfaces: {},
        pwa: { themeColor: "#123456", backgroundColor: "#f0f0f0", css: "evil" },
      }),
    ).toHaveLength(1);
  });

  it("非对象 / 空定义合法（空 surfaces = 全默认）", () => {
    expect(parseThemePackDefinition(null).ok).toBe(false);
    expect(parseThemePackDefinition("x").ok).toBe(false);
    expect(parseThemePackDefinition({ surfaces: {} })).toMatchObject({ ok: true });
  });
});

describe("renderSurfaceVars / renderSurfaceEntry（白名单变量渲染）", () => {
  it("输出键集合固定为 --sf-<area>-* 白名单；值由结构化字段合成", () => {
    const header = VALID.surfaces.header!;
    const vars = renderSurfaceVars("header", header.light);
    expect(Object.keys(vars).sort()).toEqual(
      [
        "--sf-header-bg",
        "--sf-header-blur",
        "--sf-header-border-color",
        "--sf-header-border-width",
        "--sf-header-border-style",
        "--sf-header-text",
        "--sf-header-text-muted",
        "--sf-header-text-link",
      ].sort(),
    );
    expect(vars["--sf-header-bg"]).toBe("#112233");
    expect(vars["--sf-header-blur"]).toBe("8px");
    expect(vars["--sf-header-border-width"]).toBe("1px");
  });

  it("线性渐变按 position 升序、alpha 用 color-mix 合成", () => {
    const dark = VALID.surfaces.header!.dark!;
    const vars = renderSurfaceVars("header", dark);
    expect(vars["--sf-header-bg"]).toContain("linear-gradient(90deg");
    expect(vars["--sf-header-bg"]).toContain("color-mix(in srgb, #000000 80%, transparent) 0%");
    expect(vars["--sf-header-bg"]).toContain("#222222 100%");
  });

  it("径向圆形渐变与纯色无显式遮罩强度正常渲染", () => {
    const vars = renderSurfaceVars("page", {
      fill: {
        type: "radial",
        shape: "circle",
        stops: [
          { color: "#111111", alpha: 1, position: 0 },
          { color: "#eeeeee", alpha: 1, position: 100 },
        ],
      },
      overlay: { type: "solid", color: "#ffffff" },
    });
    expect(vars["--sf-page-bg"]).toContain("radial-gradient(circle at center");
    expect(vars["--sf-page-overlay-bg"]).toBe("#ffffff");
    expect(vars["--sf-page-overlay-opacity"]).toBeUndefined();
  });

  it("图片填充：background shorthand 与混合模式/不透明度变量分离；URL 走 ?file= 查询", () => {
    const band = VALID.surfaces["forum-band"]!.light;
    const vars = renderSurfaceVars("forum-band", band);
    expect(vars["--sf-forum-band-bg"]).toContain(
      'url("/brand/decor?file=decor-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png")',
    );
    expect(vars["--sf-forum-band-bg"]).toContain("50% 50% / cover no-repeat");
    expect(vars["--sf-forum-band-bg"]).not.toContain("soft-light");
    expect(vars["--sf-forum-band-bg-blend-mode"]).toBe("soft-light");
    expect(vars["--sf-forum-band-bg-image-opacity"]).toBe("0.7");
  });

  it("图片遮罩输出独立混合模式/透明度变量", () => {
    const vars = renderSurfaceVars("forum-band", {
      overlay: {
        type: "image",
        asset: "decor-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
        position: "center",
        size: "cover",
        repeat: "no-repeat",
        blend: "multiply",
        opacity: 0.5,
        overlayOpacity: 0.8,
      },
    });
    expect(vars["--sf-forum-band-overlay-bg"]).toContain(
      'url("/brand/decor?file=decor-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png")',
    );
    expect(vars["--sf-forum-band-overlay-bg-blend-mode"]).toBe("multiply");
    expect(vars["--sf-forum-band-overlay-bg-image-opacity"]).toBe("0.5");
    expect(vars["--sf-forum-band-overlay-opacity"]).toBe("0.8");
  });

  it("内容插槽渲染到固定变量（?file= 查询地址）", () => {
    const vars = renderSurfaceVars("hero-image", {
      contentSlot: {
        image: "decor-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
        imageHeightPx: 240,
        hideText: true,
      },
    });
    expect(vars["--sf-hero-image-content-image"]).toBe(
      'url("/brand/decor?file=decor-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png")',
    );
    expect(vars["--sf-hero-image-content-image-height"]).toBe("240px");
    expect(vars["--sf-hero-image-content-hide-text"]).toBe("1");
  });

  it("内容插槽的可选字段省略时不生成变量，hideText=false 明确生成 0", () => {
    const vars = renderSurfaceVars("hero-image", { contentSlot: { hideText: false } });
    expect(vars["--sf-hero-image-content-image"]).toBeUndefined();
    expect(vars["--sf-hero-image-content-image-height"]).toBeUndefined();
    expect(vars["--sf-hero-image-content-hide-text"]).toBe("0");
  });

  it("遮罩输出独立 overlay 变量；overlayOpacity 输出", () => {
    const band = VALID.surfaces["forum-band"]!.light;
    const vars = renderSurfaceVars("forum-band", band);
    expect(vars["--sf-forum-band-overlay-bg"]).toContain("linear-gradient(105deg");
    expect(vars["--sf-forum-band-overlay-opacity"]).toBe("0.9");
  });

  it("暗色档以 --dark 后缀输出到 root:dark；暗色缺省不污染暗色档", () => {
    const rendered = renderSurfaceEntry("header", VALID.surfaces.header!);
    expect(rendered["--sf-header-bg"]).toBe("#112233");
    expect(rendered["--sf-header-bg--dark"]).toContain("linear-gradient");
    const noDark = renderSurfaceEntry("header", {
      light: { fill: { type: "solid", color: "#112233" } },
    });
    expect(noDark["--sf-header-bg--dark"]).toBeUndefined();
  });
});

describe("renderPackCssVars / cssTextForPack（整包输出）", () => {
  it("分档聚合到 root:light / root:dark；未知区域跳过（二次防御）", () => {
    const out = renderPackCssVars(VALID);
    expect(Object.keys(out).sort()).toEqual(["root:dark", "root:light"].sort());
    expect(out["root:light"]["--sf-page-bg"]).toContain("radial-gradient(ellipse at center");
    expect(out["root:dark"]["--sf-header-bg"]).toBeDefined();
    expect(out["root:dark"]["--sf-page-bg"]).toBeUndefined();
    const unknownSurface = renderPackCssVars({
      surfaces: { unregistered: { light: {} } },
    } as unknown as ThemePackDefinition);
    expect(unknownSurface["root:light"]).toEqual({});
  });

  it("cssTextForPack：浅色带 :not([data-mode=dark]) 限定、暗色带 [data-mode=dark]；值不含包内自由字符串结构", () => {
    const css = cssTextForPack("custom", VALID);
    expect(css).toContain(':root[data-pack="custom"]:not([data-mode="dark"])');
    expect(css).toContain(':root[data-pack="custom"][data-mode="dark"]');
    expect(css).not.toMatch(/expression\(|javascript:|<script/i);
    expect(css).not.toContain("evil");
    expect(cssTextForPack("empty", { surfaces: {} })).toBe("");
    expect(() => cssTextForPack('bad"] { color: red; }', VALID)).toThrow("非法主题包 id");
  });

  it("fallback（default 包）为缺省 Surface/档位兜底，自身值优先", () => {
    const pack = {
      surfaces: {
        header: { light: { fill: { type: "solid" as const, color: "#112233" } } },
      },
    };
    const fallback = {
      surfaces: {
        header: {
          light: { fill: { type: "solid" as const, color: "#000000" } },
          dark: { fill: { type: "solid" as const, color: "#0b0b0b" } },
        },
        page: { light: { fill: { type: "solid" as const, color: "#123456" } } },
      },
    };
    const out = renderPackCssVars(pack, fallback);
    // 自身 light 覆盖 fallback
    expect(out["root:light"]["--sf-header-bg"]).toBe("#112233");
    // 自身缺 dark → 继承 fallback 的 dark
    expect(out["root:dark"]["--sf-header-bg"]).toBe("#0b0b0b");
    // 整个 Surface 缺省 → 继承 fallback
    expect(out["root:light"]["--sf-page-bg"]).toBe("#123456");
    // 无 fallback 时缺省仍不输出
    const bare = renderPackCssVars(pack);
    expect(bare["root:dark"]["--sf-header-bg"]).toBeUndefined();
    expect(bare["root:light"]["--sf-page-bg"]).toBeUndefined();
    // cssTextForPack 同口径
    const css = cssTextForPack("child", pack, fallback);
    expect(css).toContain("--sf-header-bg: #0b0b0b;");
  });
});
