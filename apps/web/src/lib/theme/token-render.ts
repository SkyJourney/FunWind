import { hexToRgb } from "./color";
import {
  COLOR_KEYS,
  type DisplayFont,
  type RadiusStep,
  type Shadow,
  type TokenSet,
} from "./token-schema";

/**
 * 令牌渲染器（M11.6 Step 1）：TokenSet → CSS 变量键值对。
 *
 * 遵守引擎不变式（同 surface-render.ts）：
 *  · 只输出白名单变量键（`COLOR_KEYS` / `--radius` / `--shadow-N` 等）；
 *  · 值仅由结构化字段序列化而来，绝不拼接自由字符串进属性名；
 *  · 阴影颜色用 `rgb(r g b / a)` 表达（不用 color-mix），算出的 rgba 与 Chromium 的计算值格式一致。
 * 调用方传入的 TokenSet 应已经过 tokenSetSchema 校验；若未校验，无效的键会被跳过而不是注入 CSS。
 */

const FONT_STACKS: Record<DisplayFont, string> = {
  system: "var(--fw-font-sans)",
  songti: '"Songti SC", "STSong", SimSun, Georgia, serif',
  serif: 'Georgia, "Times New Roman", "Noto Serif CJK SC", "Noto Serif CJK JP", serif',
};

const RADIUS_VALUES: Record<RadiusStep, string> = {
  none: "0px",
  sm: "var(--fw-radius-sm)",
  md: "var(--fw-radius-md)",
  lg: "var(--fw-radius-lg)",
  xl: "var(--fw-radius-xl)",
};

/** 序列化单个阴影：`x y blur spread rgb(r g b / a)` */
function serializeShadow(s: Shadow): string {
  const [r, g, b] = hexToRgb(s.color);
  return `${s.x}px ${s.y}px ${s.blur}px ${s.spread}px rgb(${r} ${g} ${b} / ${s.alpha})`;
}

/** TokenSet → CSS 变量键值对（有值的键才输出；顺序固定 = 测试可对账） */
export function renderTokenVars(tokens: TokenSet): Record<string, string> {
  const vars: Record<string, string> = {};

  // 颜色：按 COLOR_KEYS 顺序遍历（不读 tokens.colors 自己的键，避免注入未知键）
  if (tokens.colors) {
    for (const key of COLOR_KEYS) {
      const hex = tokens.colors[key];
      if (hex && typeof hex === "string") {
        // 二次防御：只有看起来像 #RRGGBB 的才输出（schema 已拒绝，这里防万一）
        if (/^#[0-9A-Fa-f]{6}$/.test(hex)) {
          vars[`--${key}`] = hex.toLowerCase();
        }
      }
    }
  }

  // 圆角：none = 0px，其余对应 --fw-radius-<档>
  if (tokens.radius && Object.hasOwn(RADIUS_VALUES, tokens.radius)) {
    vars["--radius"] = RADIUS_VALUES[tokens.radius];
  }

  // 阴影：逐档检查并序列化
  if (tokens.shadows) {
    if (tokens.shadows.s1) vars["--shadow-1"] = serializeShadow(tokens.shadows.s1);
    if (tokens.shadows.s2) vars["--shadow-2"] = serializeShadow(tokens.shadows.s2);
    if (tokens.shadows.s3) vars["--shadow-3"] = serializeShadow(tokens.shadows.s3);
  }

  // 展示字体：通过查表映射，未知档位跳过
  if (tokens.displayFont && Object.hasOwn(FONT_STACKS, tokens.displayFont)) {
    vars["--fw-font-display"] = FONT_STACKS[tokens.displayFont];
  }

  // 品牌渐变：angle / from / to → linear-gradient(...)
  if (tokens.brandGradient) {
    const { angle, from, to } = tokens.brandGradient;
    if (
      typeof angle === "number" &&
      typeof from === "string" &&
      typeof to === "string" &&
      /^#[0-9A-Fa-f]{6}$/.test(from) &&
      /^#[0-9A-Fa-f]{6}$/.test(to)
    ) {
      vars["--gradient-brand"] =
        `linear-gradient(${angle}deg, ${from.toLowerCase()}, ${to.toLowerCase()})`;
    }
  }

  // 板块卡参数：width rem / angle deg / fade % / dim / mask block|none / maskColor（可选）
  if (tokens.band) {
    const { width, angle, fade, dim, mask, maskColor } = tokens.band;
    if (typeof width === "number" && Number.isFinite(width)) {
      vars["--band-width"] = `${width}rem`;
    }
    if (typeof angle === "number" && Number.isFinite(angle)) {
      vars["--band-angle"] = `${angle}deg`;
    }
    if (typeof fade === "number" && Number.isFinite(fade)) {
      vars["--band-fade"] = `${fade}%`;
    }
    if (typeof dim === "number" && Number.isFinite(dim)) {
      vars["--band-dim-opacity"] = String(dim);
    }
    if (typeof mask === "boolean") {
      vars["--band-mask-display"] = mask ? "block" : "none";
    }
    if (maskColor && typeof maskColor === "string" && /^#[0-9A-Fa-f]{6}$/.test(maskColor)) {
      vars["--band-mask-color"] = maskColor.toLowerCase();
    }
  }

  return vars;
}
