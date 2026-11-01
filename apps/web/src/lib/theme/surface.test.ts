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
          asset: "decor-abc.png",
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
  });

  it("图片填充：未知字段 / 非法 position / 非枚举 blend / 越界 opacity 拒绝；url 与 data: 在 asset 值外无法注入", () => {
    expect(
      rejected({
        surfaces: {
          "forum-band": {
            light: {
              fill: {
                type: "image",
                asset: "x.png",
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
                asset: "x.png",
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
                asset: "x.png",
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
                asset: "x.png",
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

  it("图片填充：输出 /brand/decor 引用 + position/size/repeat/blend；半透明输出独立 opacity 变量", () => {
    const band = VALID.surfaces["forum-band"]!.light;
    const vars = renderSurfaceVars("forum-band", band);
    expect(vars["--sf-forum-band-bg"]).toContain('url("/brand/decor/decor-abc.png")');
    expect(vars["--sf-forum-band-bg"]).toContain("50% 50% / cover");
    expect(vars["--sf-forum-band-bg"]).toContain("soft-light");
    expect(vars["--sf-forum-band-bg-image-opacity"]).toBe("0.7");
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
  });

  it("cssTextForPack：浅色带 :not([data-mode=dark]) 限定、暗色带 [data-mode=dark]；值不含包内自由字符串结构", () => {
    const css = cssTextForPack("custom", VALID);
    expect(css).toContain(':root[data-pack="custom"]:not([data-mode="dark"])');
    expect(css).toContain(':root[data-pack="custom"][data-mode="dark"]');
    expect(css).not.toMatch(/expression\(|javascript:|<script/i);
    expect(css).not.toContain("evil");
  });
});
