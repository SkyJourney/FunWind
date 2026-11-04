import type {
  FillSpec,
  OverlaySpec,
  SurfaceCapabilities,
  SurfaceEntry,
  SurfaceId,
  ThemePackDefinition,
} from "./surface-schema";
import { isSurfaceId } from "./surface-registry";
import { decorUrl } from "./decor-url";
import { renderTokenVars } from "./token-render";

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
      return [`url("${decorUrl(fill.asset)}")`, fill.position, `/ ${fill.size}`, fill.repeat].join(
        " ",
      );
  }
}

/** 图片填充的混合模式和不透明度由独立变量表达，不拼入 background shorthand */
function fillImageOpacity(fill: FillSpec): string | null {
  return fill.type === "image" ? String(fill.opacity) : null;
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
    if (imgOpacity !== null) {
      vars[`--sf-${area}-bg-image-opacity`] = imgOpacity;
      if (caps.fill.type === "image") {
        vars[`--sf-${area}-bg-blend-mode`] = caps.fill.blend;
      }
    }
  }
  if (caps.overlay) {
    vars[`--sf-${area}-overlay-bg`] = overlayToBackground(caps.overlay);
    const oo = (caps.overlay as { overlayOpacity?: number }).overlayOpacity;
    if (typeof oo === "number") vars[`--sf-${area}-overlay-opacity`] = String(oo);
    // 图片遮罩：自身混合模式与不透明度同样走独立变量（与 fill 图片同口径）
    if (caps.overlay.type === "image") {
      vars[`--sf-${area}-overlay-bg-blend-mode`] = caps.overlay.blend;
      vars[`--sf-${area}-overlay-bg-image-opacity`] = String(caps.overlay.opacity);
    }
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
  if (caps.contentSlot) {
    if (caps.contentSlot.image) {
      vars[`--sf-${area}-content-image`] = `url("${decorUrl(caps.contentSlot.image)}")`;
    }
    if (typeof caps.contentSlot.imageHeightPx === "number") {
      vars[`--sf-${area}-content-image-height`] = `${caps.contentSlot.imageHeightPx}px`;
    }
    if (typeof caps.contentSlot.hideText === "boolean") {
      vars[`--sf-${area}-content-hide-text`] = caps.contentSlot.hideText ? "1" : "0";
    }
  }
  return vars;
}

/** 渲染一个 Surface 明/暗两档；fallback 提供缺省档的兜底值（default 包定义），自身值优先 */
export function renderSurfaceEntry(
  area: SurfaceId,
  entry: SurfaceEntry | undefined,
  fallback?: SurfaceEntry,
): CssVarMap {
  const out: CssVarMap = {};
  // 空能力对象视同未声明：整 Surface/整档缺省时也要继承 fallback（default 包）
  const light =
    entry?.light && Object.keys(entry.light).length > 0
      ? entry.light
      : (fallback?.light ?? undefined);
  if (light) {
    for (const [key, value] of Object.entries(renderSurfaceVars(area, light))) {
      out[key] = value;
    }
  }
  const dark =
    entry?.dark && Object.keys(entry.dark).length > 0 ? entry.dark : (fallback?.dark ?? undefined);
  if (dark) {
    for (const [key, value] of Object.entries(renderSurfaceVars(area, dark))) {
      out[`${key}--dark`] = value;
    }
  }
  return out;
}

/**
 * 渲染整包：`{ "selector:var": value }` 的扁平集合。
 * 选择器约定：`root:light`（:root，即默认浅色档）、`root:dark`（[data-mode="dark"] 档）。
 * 未注册区域在 schema 层已拒绝，此处二次防御跳过。
 * fallbackDefinition（通常 = default 包）：本包未声明的 Surface/档位用它兜底（回退链 包值 → default 包 → 内置 CSS）。
 * 令牌（M11.6）：不继承 fallbackDefinition 的 tokens（基础层本来就在 CSS），只渲染本包自己的令牌。
 */
export function renderPackCssVars(
  definition: ThemePackDefinition,
  fallbackDefinition?: ThemePackDefinition,
): Record<string, CssVarMap> {
  const out: Record<string, CssVarMap> = { "root:light": {}, "root:dark": {} };
  const areas = new Set([
    ...Object.keys(definition.surfaces),
    ...Object.keys(fallbackDefinition?.surfaces ?? {}),
  ]);
  for (const area of areas) {
    if (!isSurfaceId(area)) continue;
    const rendered = renderSurfaceEntry(
      area as SurfaceId,
      definition.surfaces[area],
      fallbackDefinition?.surfaces[area],
    );
    for (const [key, value] of Object.entries(rendered)) {
      if (key.endsWith("--dark")) {
        out["root:dark"][key.replace(/--dark$/, "")] = value;
      } else {
        out["root:light"][key] = value;
      }
    }
  }

  // 令牌变量追加到 :root 与 [data-mode="dark"]（只渲染本包自己的，不继承 fallbackDefinition.tokens）
  const tokens = definition.tokens;
  if (tokens?.light) {
    Object.assign(out["root:light"], renderTokenVars(tokens.light));
  }
  if (tokens?.dark) {
    Object.assign(out["root:dark"], renderTokenVars(tokens.dark));
  }

  return out;
}

/** 输出为可直接内联 `<style>` 的 CSS 文本（含 data-pack 限定），值仅来自白名单渲染器 */
export function cssTextForPack(
  packId: string,
  definition: ThemePackDefinition,
  fallbackDefinition?: ThemePackDefinition,
): string {
  if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(packId)) {
    throw new Error("非法主题包 id");
  }
  const bySelector = renderPackCssVars(definition, fallbackDefinition);
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
