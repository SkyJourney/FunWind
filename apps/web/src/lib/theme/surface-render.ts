import type {
  FillSpec,
  OverlaySpec,
  SurfaceCapabilities,
  SurfaceEntry,
  SurfaceId,
  ThemePackDefinition,
} from "./surface-schema";
import { isSurfaceId } from "./surface-schema";

/**
 * Surface 渲染器（M11.1 Step 1，纯函数）：包 definition → 固定 `--sf-<area>-*` CSS 变量键值对。
 * 不变式（docs/milestones/M11.1-theme-engine.md §0.3）：
 *  · 只输出白名单变量键（键集合由代码决定，包数据只填值）；
 *  · 值仅由结构化字段序列化而来，绝不拼接包内自由字符串进属性名；
 *  · 渐变透明度用 color-mix/oklab 内插表达（颜色本身 #RRGGBB，alpha 由渲染器合成）。
 * 数据包经 SSR layout 注入 `<style>`；内置包静态 CSS 仍保留（数据值优先级更高）。
 */

export type CssVarMap = Record<string, string>;

const percent = (n: number) => `${n}%`;

/** alpha 0–1 + #RRGGBB → color-mix 透明色（渲染器统一出口，避免包数据携带 css 函数） */
function withAlpha(color: string, alpha: number): string {
  if (alpha >= 1) return color;
  const pct = Math.round(alpha * 10_000) / 100;
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`;
}

function gradientOf(
  kind: "linear" | "radial",
  shape: string | undefined,
  angle: number | undefined,
  stops: { color: string; alpha: number; position: number }[],
): string {
  const list = [...stops]
    .sort((a, b) => a.position - b.position)
    .map((s) => `${withAlpha(s.color, s.alpha)} ${percent(s.position)}`)
    .join(", ");
  return kind === "linear"
    ? `linear-gradient(${angle ?? 0}deg, ${list})`
    : `radial-gradient(${shape === "ellipse" ? "ellipse" : "circle"} at center, ${list})`;
}

function fillToBackground(fill: FillSpec): string {
  switch (fill.type) {
    case "solid":
      return fill.color;
    case "linear":
      return gradientOf("linear", undefined, fill.angle, fill.stops);
    case "radial":
      return gradientOf("radial", fill.shape, undefined, fill.stops);
    case "image":
      return [
        `url("/brand/decor/${encodeURIComponent(fill.asset)}")`,
        fill.position,
        `/ ${fill.size}`,
        fill.repeat,
        fill.blend !== "normal" ? fill.blend : "",
      ]
        .filter(Boolean)
        .join(" ");
  }
}

/** 图片填充的不透明度通过叠加层表达：fill 为 image 且 opacity<1 时返回覆盖变量值 */
function fillImageOpacity(fill: FillSpec): string | null {
  return fill.type === "image" && fill.opacity < 1 ? String(fill.opacity) : null;
}

function overlayToBackground(overlay: OverlaySpec): string {
  // overlay 与 fill 同构；overlayOpacity 由独立变量表达
  return fillToBackground(overlay as unknown as FillSpec);
}

/** 渲染单个 Surface 的能力 → `--sf-<area>-*` 变量（浅色或暗色档共用本函数） */
export function renderSurfaceVars(area: SurfaceId, caps: SurfaceCapabilities): CssVarMap {
  const vars: CssVarMap = {};
  if (caps.fill) {
    vars[`--sf-${area}-bg`] = fillToBackground(caps.fill);
    const imgOpacity = fillImageOpacity(caps.fill);
    if (imgOpacity !== null) vars[`--sf-${area}-bg-image-opacity`] = imgOpacity;
  }
  if (caps.overlay) {
    vars[`--sf-${area}-overlay-bg`] = overlayToBackground(caps.overlay);
    const oo = (caps.overlay as { overlayOpacity?: number }).overlayOpacity;
    if (typeof oo === "number") vars[`--sf-${area}-overlay-opacity`] = String(oo);
  }
  if (caps.border) {
    vars[`--sf-${area}-border-color`] = caps.border.color;
    vars[`--sf-${area}-border-width`] = `${caps.border.width}px`;
    vars[`--sf-${area}-border-style`] = caps.border.style;
  }
  if (caps.text) {
    vars[`--sf-${area}-text`] = caps.text.primary;
    vars[`--sf-${area}-text-muted`] = caps.text.muted;
    vars[`--sf-${area}-text-link`] = caps.text.link;
  }
  if (typeof caps.blur === "number") {
    vars[`--sf-${area}-blur`] = `${caps.blur}px`;
  }
  return vars;
}

/** 渲染一个 Surface 明/暗两档：dark 缺省 = 不输出（回退 default 包暗色档） */
export function renderSurfaceEntry(area: SurfaceId, entry: SurfaceEntry): CssVarMap {
  const out: CssVarMap = {};
  for (const [key, value] of Object.entries(renderSurfaceVars(area, entry.light))) {
    out[key] = value;
  }
  if (entry.dark) {
    for (const [key, value] of Object.entries(renderSurfaceVars(area, entry.dark))) {
      out[`${key}--dark`] = value;
    }
  }
  return out;
}

/**
 * 渲染整包：`{ "selector:var": value }` 的扁平集合。
 * 选择器约定：`root:light`（:root，即默认浅色档）、`root:dark`（[data-mode="dark"] 档）。
 * 未注册区域在 schema 层已拒绝，此处二次防御跳过。
 */
export function renderPackCssVars(definition: ThemePackDefinition): Record<string, CssVarMap> {
  const out: Record<string, CssVarMap> = { "root:light": {}, "root:dark": {} };
  for (const [area, entry] of Object.entries(definition.surfaces) as [string, SurfaceEntry][]) {
    if (!isSurfaceId(area)) continue;
    const rendered = renderSurfaceEntry(area as SurfaceId, entry);
    for (const [key, value] of Object.entries(rendered)) {
      if (key.endsWith("--dark")) {
        out["root:dark"][key.replace(/--dark$/, "")] = value;
      } else {
        out["root:light"][key] = value;
      }
    }
  }
  return out;
}

/** 输出为可直接内联 `<style>` 的 CSS 文本（含 data-pack 限定），值仅来自白名单渲染器 */
export function cssTextForPack(packId: string, definition: ThemePackDefinition): string {
  const bySelector = renderPackCssVars(definition);
  const parts: string[] = [];
  const light = bySelector["root:light"];
  const dark = bySelector["root:dark"];
  if (Object.keys(light).length > 0) {
    const body = Object.entries(light)
      .map(([k, v]) => `  ${k}: ${v};`)
      .join("\n");
    parts.push(`:root[data-pack="${packId}"]:not([data-mode="dark"]) {\n${body}\n}`);
  }
  if (Object.keys(dark).length > 0) {
    const body = Object.entries(dark)
      .map(([k, v]) => `  ${k}: ${v};`)
      .join("\n");
    parts.push(`:root[data-pack="${packId}"][data-mode="dark"] {\n${body}\n}`);
  }
  return parts.join("\n");
}
