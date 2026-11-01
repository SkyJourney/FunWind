import { z } from "zod";

/**
 * Surface 定义 schema（M11.1，docs/milestones/M11.1-theme-engine.md §0）。
 * 主题包 definition 的安全边界：只接受结构化字段 → 渲染器映射到固定 CSS 变量键；
 * 任何 CSS 字符串、URL、data URI、未知字段都在此层拒绝，绝不进入运行时样式。
 */

/** #RRGGBB 严格色值（透明度用结构化 alpha 表达，不接受 rgba/css 函数） */
export const hexColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "非法颜色（须 #RRGGBB）");

/** alpha 0–1，保留两位小数以内 */
export const alphaSchema = z.number().min(0).max(1);

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
      asset: z.string().max(80),
      position: z
        .string()
        .regex(
          /^(top|bottom|left|right|center|\d{1,3}% \d{1,3}%)$/,
          "非法 position（单关键词或「X% Y%」）",
        ),
      size: z.enum(["cover", "contain", "auto"]).or(z.string().regex(/^\d{1,3}%$/)),
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
    image: z.string().max(80).optional(),
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
  })
  .strict();

/** 明/暗两档 Surface 定义（暗色缺省 = 回退 default 包的暗色档） */
export const surfaceEntrySchema = z
  .object({
    light: surfaceCapabilitiesSchema,
    dark: surfaceCapabilitiesSchema.optional(),
  })
  .strict();

/** 包 definition：SurfaceId → 明/暗定义；未知字段/未知区域拒绝 */
export const themePackDefinitionSchema = z
  .object({
    surfaces: z.record(z.string(), surfaceEntrySchema),
  })
  .strict();

export type HexColor = z.infer<typeof hexColorSchema>;
export type GradientStop = z.infer<typeof gradientStopSchema>;
export type FillSpec = z.infer<typeof fillSchema>;
export type OverlaySpec = z.infer<typeof overlaySchema>;
export type SurfaceCapabilities = z.infer<typeof surfaceCapabilitiesSchema>;
export type SurfaceEntry = z.infer<typeof surfaceEntrySchema>;
export type ThemePackDefinition = z.infer<typeof themePackDefinitionSchema>;

/** Surface 实例注册表（区域 id + 后台显示名 + 启用能力集）——代码内白名单 */
export const SURFACES = [
  {
    id: "header",
    label: "顶部导航",
    caps: ["fill", "overlay", "border", "blur", "text", "contentSlot"],
  },
  { id: "hero-brand", label: "首页品牌区", caps: ["fill", "overlay", "text", "contentSlot"] },
  { id: "banner-announce", label: "公告横幅", caps: ["fill", "text", "contentSlot"] },
  { id: "forum-band", label: "板块卡底纹", caps: ["fill", "overlay"] },
  { id: "hero-image", label: "首页 Hero 图", caps: ["contentSlot"] },
  { id: "tabbar", label: "底部 Tab", caps: ["fill", "blur", "border"] },
  { id: "footer", label: "页脚", caps: ["fill", "border", "text"] },
  { id: "auth", label: "登录/注册壳", caps: ["fill", "overlay"] },
  { id: "page", label: "全局页面背景", caps: ["fill"] },
] as const;

export type SurfaceId = (typeof SURFACES)[number]["id"];

export function isSurfaceId(v: string): v is SurfaceId {
  return SURFACES.some((s) => s.id === v);
}

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
  for (const surfaceId of Object.keys(parsed.data.surfaces)) {
    if (!isSurfaceId(surfaceId)) errors.push(`surfaces.${surfaceId}: 未注册的区域`);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: parsed.data };
}
