import {
  BASE_BAND,
  BASE_SHADOWS,
  SHADOW_SLOTS,
  effectiveColors,
  type ColorMode,
  type ShadowSlot,
} from "@/lib/theme/token-base";
import { COLOR_KEYS, type ColorKey, type Shadow, type TokenSet } from "@/lib/theme/token-schema";
import type { ThemePackDefinition } from "@/lib/theme/surface-schema";

/**
 * 令牌编辑器的纯逻辑（M11.6 Step 3c）：分组、中文名、字段规格、起点值，以及对 TokenSet 的不可变增删改。
 *
 * 约定：
 *  · 缺省的键 = 继承基础层。「恢复继承」= 删除这个键，绝不写 undefined（对象形状要与 JSON 往返一致）；
 *  · 清空到没有任何覆盖的 `colors` / `shadows` 子对象一并删除，不残留空壳；
 *  · 深色档与浅色档不对称：浅色档改空就整档删除，深色档保留空集——空集表示「已启用深色令牌、全部继承」，
 *    这是编辑器的一个显式状态，删除它（关闭深色令牌）需要单独的动作。
 */

type Band = NonNullable<TokenSet["band"]>;
type Colors = Partial<Record<ColorKey, string>>;
type Shadows = NonNullable<TokenSet["shadows"]>;

export interface ColorGroup {
  id: string;
  label: string;
  items: readonly { key: ColorKey; label: string }[];
}

/** 22 个语义色按用途分组，组内顺序即编辑器里的显示顺序；每个键恰好出现一次（单测守住） */
export const COLOR_GROUPS: readonly ColorGroup[] = [
  {
    id: "base",
    label: "基础",
    items: [
      { key: "background", label: "页面底" },
      { key: "foreground", label: "正文" },
      { key: "card", label: "卡片底" },
      { key: "card-foreground", label: "卡片上的文字" },
      { key: "popover", label: "弹层底" },
      { key: "popover-foreground", label: "弹层上的文字" },
      { key: "muted", label: "弱化底" },
      { key: "muted-foreground", label: "弱化文字" },
    ],
  },
  {
    id: "brand",
    label: "品牌",
    items: [
      { key: "primary", label: "主色" },
      { key: "primary-foreground", label: "主色上的文字" },
      { key: "secondary", label: "次要底" },
      { key: "secondary-foreground", label: "次要底上的文字" },
      { key: "accent", label: "强调底" },
      { key: "accent-foreground", label: "强调底上的文字" },
    ],
  },
  {
    id: "status",
    label: "状态",
    items: [
      { key: "destructive", label: "危险色" },
      { key: "destructive-foreground", label: "危险色上的文字" },
      { key: "success", label: "成功色" },
      { key: "warning", label: "警告色" },
      { key: "info", label: "信息色" },
    ],
  },
  {
    id: "line",
    label: "边框与焦点",
    items: [
      { key: "border", label: "边框" },
      { key: "input", label: "输入框边框" },
      { key: "ring", label: "焦点环" },
    ],
  },
];

/** 数字字段的规格：范围与 token-schema.ts 一致（单测用 schema 逐项交叉验证，改一处漏另一处会变红） */
export interface NumberSpec<K extends string> {
  key: K;
  label: string;
  unit?: string;
  min: number;
  max: number;
  integer?: boolean;
  decimals?: number;
}

export const SHADOW_FIELDS: readonly NumberSpec<"x" | "y" | "blur" | "spread" | "alpha">[] = [
  { key: "x", label: "横向偏移", unit: "px", min: -64, max: 64, integer: true },
  { key: "y", label: "纵向偏移", unit: "px", min: -64, max: 64, integer: true },
  { key: "blur", label: "模糊", unit: "px", min: 0, max: 80, integer: true },
  { key: "spread", label: "扩展", unit: "px", min: -32, max: 32, integer: true },
  { key: "alpha", label: "不透明度", min: 0, max: 1 },
];

/**
 * 板块卡的三个数字参数。schema 里还有 `dim`（整体压暗），它只在 `data-band-mask="dim"` 时生效，
 * 而目前没有任何组件设置这个属性，所以编辑器不给控件；已有的值照原样保留。
 */
export const BAND_FIELDS: readonly NumberSpec<"width" | "angle" | "fade">[] = [
  { key: "width", label: "图区宽度", unit: "rem", min: 0, max: 16 },
  { key: "angle", label: "遮罩角度", unit: "°", min: 0, max: 359, integer: true },
  { key: "fade", label: "渐隐宽度", unit: "%", min: 0, max: 100, integer: true },
];

export const GRADIENT_ANGLE_FIELD: NumberSpec<"angle"> = {
  key: "angle",
  label: "角度",
  unit: "°",
  min: 0,
  max: 359,
  integer: true,
};

export const SHADOW_LABELS: Readonly<Record<ShadowSlot, string>> = {
  s1: "阴影 1",
  s2: "阴影 2",
  s3: "阴影 3",
};

/** 去掉一个键，返回新对象；不产生值为 undefined 的键 */
function omit<T extends object>(source: T, key: keyof T): T {
  return Object.fromEntries(Object.entries(source).filter(([name]) => name !== key)) as T;
}

/** 删掉没有任何覆盖的 colors / shadows 空壳 */
function prune(set: TokenSet): TokenSet {
  const out: TokenSet = { ...set };
  if (out.colors && Object.keys(out.colors).length === 0) delete out.colors;
  if (out.shadows && Object.keys(out.shadows).length === 0) delete out.shadows;
  return out;
}

export function setColor(set: TokenSet, key: ColorKey, hex: string): TokenSet {
  return { ...set, colors: { ...set.colors, [key]: hex } };
}

export function clearColor(set: TokenSet, key: ColorKey): TokenSet {
  const colors: Colors = omit(set.colors ?? {}, key);
  return prune({ ...set, colors });
}

export function setShadow(set: TokenSet, slot: ShadowSlot, shadow: Shadow): TokenSet {
  return { ...set, shadows: { ...set.shadows, [slot]: shadow } };
}

export function clearShadow(set: TokenSet, slot: ShadowSlot): TokenSet {
  const shadows: Shadows = omit(set.shadows ?? {}, slot);
  return prune({ ...set, shadows });
}

/** 整体覆盖的四个字段：圆角、展示字体、品牌渐变、板块卡 */
export type FieldKey = "radius" | "displayFont" | "brandGradient" | "band";

export function setField<K extends FieldKey>(
  set: TokenSet,
  key: K,
  value: NonNullable<TokenSet[K]>,
): TokenSet {
  return { ...set, [key]: value };
}

export function clearField(set: TokenSet, key: FieldKey): TokenSet {
  return omit(set, key);
}

/** 已覆盖的项数：只数认识的键（未知键与空壳不计），用于折叠面板的摘要 */
export function countOverrides(set: TokenSet | undefined): number {
  if (!set) return 0;
  const colors = COLOR_KEYS.filter((key) => set.colors?.[key] !== undefined).length;
  const shadows = SHADOW_SLOTS.filter((slot) => set.shadows?.[slot] !== undefined).length;
  const fields = [set.radius, set.displayFont, set.brandGradient, set.band].filter(
    (value) => value !== undefined,
  ).length;
  return colors + shadows + fields;
}

type Tokens = NonNullable<ThemePackDefinition["tokens"]>;

/** 浅色档为空就整档删除；浅深两档都没有则整个 tokens 不存在 */
function normalizeTokens(tokens: Tokens): Tokens | undefined {
  const out: Tokens = { ...tokens };
  if (out.light && Object.keys(out.light).length === 0) delete out.light;
  return out.light || out.dark ? out : undefined;
}

/** 改某一档，另一档原样（同一引用）。编辑深色档即视为已启用深色令牌 */
export function updateTokens(
  tokens: ThemePackDefinition["tokens"],
  mode: ColorMode,
  update: (set: TokenSet) => TokenSet,
): ThemePackDefinition["tokens"] {
  const next = update(tokens?.[mode] ?? {});
  return normalizeTokens(mode === "light" ? { ...tokens, light: next } : { ...tokens, dark: next });
}

/** 启用深色令牌：创建空集（全部继承），已有则保持不动，绝不复制浅色档的值 */
export function enableDark(tokens: ThemePackDefinition["tokens"]): Tokens {
  return { ...tokens, dark: tokens?.dark ?? {} };
}

/** 关闭深色令牌：删除整个深色集 */
export function disableDark(tokens: ThemePackDefinition["tokens"]): ThemePackDefinition["tokens"] {
  return tokens ? normalizeTokens(omit(tokens, "dark")) : undefined;
}

/**
 * 把令牌写回定义。传 undefined 表示没有令牌，会**删掉**定义里原有的 tokens 键：
 * 编辑器用「基础定义 + 编辑后的定义」合成结果，若只做展开合并，清空的令牌会从基础定义里复活。
 */
export function withTokens(
  definition: ThemePackDefinition,
  tokens: ThemePackDefinition["tokens"],
): ThemePackDefinition {
  const out: ThemePackDefinition = { ...definition };
  if (tokens) out.tokens = tokens;
  else delete out.tokens;
  return out;
}

/** 「覆盖」阴影的起点：基础层的值；浅色阴影 1 例外，基础层是两层叠加，这里取较大的一层（见 token-base.ts） */
export function shadowSeed(mode: ColorMode, slot: ShadowSlot): Shadow {
  return { ...BASE_SHADOWS[mode][slot] };
}

/** 「覆盖」板块卡的起点：与基础层同值（不含遮罩色，没有遮罩色就是跟随卡片底色） */
export function bandSeed(): Band {
  return { ...BASE_BAND };
}

/**
 * 「覆盖」品牌渐变的起点：主色 → 强调底，取当前这一档生效的颜色。
 * 基础层的品牌渐变是三色半透明叠加，令牌只能表达两个不透明色标，所以这不是同值起点，而是一个协调的默认。
 */
export function gradientSeed(
  mode: ColorMode,
  overrides: Colors | undefined,
): NonNullable<TokenSet["brandGradient"]> {
  const colors = effectiveColors(mode, overrides);
  return { angle: 135, from: colors.primary, to: colors.accent };
}

type Gradient = NonNullable<TokenSet["brandGradient"]>;

/**
 * 改阴影的某几个字段：以该档现有的值为底，没有就从基础层起点开始。
 * 回调里一律读「最新的 set」再合并，不要用渲染时捕获的值，否则两次紧挨着的编辑会互相覆盖。
 */
export function patchShadow(
  set: TokenSet,
  mode: ColorMode,
  slot: ShadowSlot,
  patch: Partial<Shadow>,
): TokenSet {
  return setShadow(set, slot, { ...(set.shadows?.[slot] ?? shadowSeed(mode, slot)), ...patch });
}

/** 改品牌渐变的某几个字段，没有就从协调的默认起点开始 */
export function patchGradient(set: TokenSet, mode: ColorMode, patch: Partial<Gradient>): TokenSet {
  return setField(set, "brandGradient", {
    ...(set.brandGradient ?? gradientSeed(mode, set.colors)),
    ...patch,
  });
}

/** 改板块卡的某几个字段，没有就从基础层起点开始；`dim` 与未改动的字段原样保留 */
export function patchBand(set: TokenSet, patch: Partial<Band>): TokenSet {
  return setField(set, "band", { ...(set.band ?? bandSeed()), ...patch });
}

/** 取消「指定遮罩色」：遮罩色回到跟随卡片底色。键被删除，不写 undefined */
export function clearBandMaskColor(set: TokenSet): TokenSet {
  return set.band ? setField(set, "band", omit(set.band, "maskColor")) : set;
}
