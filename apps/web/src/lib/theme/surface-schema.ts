import { z } from "zod";
import { SURFACES } from "./surface-registry";
export { isSurfaceId, SURFACES } from "./surface-registry";
export type { SurfaceId } from "./surface-registry";

/**
 * Surface 定义 schema（M11.1，docs/milestones/M11.1-theme-engine.md §0）。
 * 主题包 definition 的安全边界：只接受结构化字段 → 渲染器映射到固定 CSS 变量键；
 * 任何 CSS 字符串、URL、data URI、未知字段都在此层拒绝，绝不进入运行时样式。
 */

/** #RRGGBB 严格色值（透明度用结构化 alpha 表达，不接受 rgba/css 函数） */
export const hexColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "非法颜色（须 #RRGGBB）");

/** alpha 0–1，最多保留两位小数 */
export const alphaSchema = z
  .number()
  .min(0)
  .max(1)
  .refine(
    (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8,
    "透明度最多保留两位小数",
  );

/** 渐变色标：颜色 + 不透明度 + 位置百分比（strict：未知字段拒绝，防任意 CSS 注入） */
export const gradientStopSchema = z
  .object({
    color: hexColorSchema,
    alpha: alphaSchema,
    position: z.number().min(0).max(100),
  })
  .strict();

const gradientStops = z.array(gradientStopSchema).min(2).max(8);

/** 背景填充：纯色 / 线性渐变 / 径向渐变 / 图片（decor 池资产引用） */
export const fillSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("solid"), color: hexColorSchema }).strict(),
  z
    .object({ type: z.literal("linear"), angle: z.number().min(0).max(359), stops: gradientStops })
    .strict(),
  z
    .object({
      type: z.literal("radial"),
      shape: z.enum(["circle", "ellipse"]),
      stops: gradientStops,
    })
    .strict(),
  z
    .object({
      type: z.literal("image"),
      asset: z.string().regex(/^decor-[a-f0-9]{32}\.png$/, "非法装饰素材引用"),
      position: z
        .string()
        .refine(
          (value) =>
            [
              "top",
              "bottom",
              "left",
              "right",
              "center",
              "top left",
              "top center",
              "top right",
              "center left",
              "center center",
              "center right",
              "bottom left",
              "bottom center",
              "bottom right",
            ].includes(value) || /^(100|[0-9]{1,2})% (100|[0-9]{1,2})%$/.test(value),
          "非法图片位置",
        ),
      size: z.enum(["cover", "contain", "auto"]).or(z.string().regex(/^(100|[1-9]\d?)%$/)),
      repeat: z.enum(["no-repeat", "repeat", "repeat-x", "repeat-y"]),
      blend: z.enum(["normal", "multiply", "screen", "overlay", "soft-light", "luminosity"]),
      opacity: alphaSchema,
    })
    .strict(),
]);

export const overlaySchema = z.intersection(
  fillSchema,
  z.object({ overlayOpacity: alphaSchema.optional() }).strict(),
);

export const borderSchema = z
  .object({
    color: hexColorSchema,
    width: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    style: z.enum(["solid", "dashed"]),
  })
  .strict();

export const textColorsSchema = z
  .object({
    primary: hexColorSchema,
    muted: hexColorSchema,
    link: hexColorSchema,
  })
  .strict();

export const contentSlotSchema = z
  .object({
    /** decor 池素材引用（横幅图/挂件图等）；无 = 区域按默认渲染 */
    image: z
      .string()
      .regex(/^decor-[a-f0-9]{32}\.png$/, "非法装饰素材引用")
      .optional(),
    /** 图片替代高度（仅 hero-image/banner 类内容槽有意义，px 120–480） */
    imageHeightPx: z.number().int().min(120).max(480).optional(),
    /** 是否隐藏区域自有文字（如用纯图 banner 替代公告文字） */
    hideText: z.boolean().optional(),
  })
  .strict();

export const surfaceCapabilitiesSchema = z
  .object({
    fill: fillSchema.optional(),
    overlay: overlaySchema.optional(),
    border: borderSchema.optional(),
    text: textColorsSchema.optional(),
    blur: z.number().int().min(0).max(24).optional(),
    contentSlot: contentSlotSchema.optional(),
  })
  .strict();

/** 明/暗两档 Surface 定义（暗色缺省 = 回退 default 包的暗色档） */
export const surfaceEntrySchema = z
  .object({
    light: surfaceCapabilitiesSchema,
    dark: surfaceCapabilitiesSchema.optional(),
  })
  .strict();

export const themePackPwaSchema = z
  .object({
    themeColor: hexColorSchema,
    backgroundColor: hexColorSchema,
  })
  .strict();

/** 包 definition：SurfaceId → 明/暗定义与 PWA 颜色；未知字段/未知区域拒绝 */
export const themePackDefinitionSchema = z
  .object({
    surfaces: z.record(z.string(), surfaceEntrySchema),
    pwa: themePackPwaSchema.optional(),
  })
  .strict();

export type HexColor = z.infer<typeof hexColorSchema>;
export type GradientStop = z.infer<typeof gradientStopSchema>;
export type FillSpec = z.infer<typeof fillSchema>;
export type OverlaySpec = z.infer<typeof overlaySchema>;
export type SurfaceCapabilities = z.infer<typeof surfaceCapabilitiesSchema>;
export type SurfaceEntry = z.infer<typeof surfaceEntrySchema>;
export type ThemePackPwa = z.infer<typeof themePackPwaSchema>;
export type ThemePackDefinition = z.infer<typeof themePackDefinitionSchema>;

/** 校验包 definition：结构合法 + 只含已注册 Surface + 未启用的能力不出现在定义里 */
export function parseThemePackDefinition(
  raw: unknown,
): { ok: true; value: ThemePackDefinition } | { ok: false; errors: string[] } {
  const parsed = themePackDefinitionSchema.strict().safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }
  const errors: string[] = [];
  for (const [surfaceId, entry] of Object.entries(parsed.data.surfaces)) {
    const surface = SURFACES.find((candidate) => candidate.id === surfaceId);
    if (!surface) {
      errors.push(`surfaces.${surfaceId}: 未注册的区域`);
      continue;
    }
    const allowed = new Set<string>(surface.caps);
    for (const mode of ["light", "dark"] as const) {
      const capabilities = entry[mode];
      if (!capabilities) continue;
      for (const capability of Object.keys(capabilities)) {
        if (!allowed.has(capability)) {
          errors.push(`surfaces.${surfaceId}.${mode}.${capability}: 该区域不支持此能力`);
        }
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: parsed.data };
}
