import { z } from "zod";
import { alphaSchema, hexColorSchema } from "./color";

/**
 * 语义令牌层 schema（M11.6，docs/milestones/M11.6-theme-semantic-tokens.md §3.1）。
 *
 * 主题包 definition 里可选的 `tokens` 段：按浅 / 深两档覆盖基础层（semantic.css / dark.css）的语义变量。
 * 遵守引擎既有不变式（同 surface-schema.ts）：
 *  · 键集合由代码决定，包数据只填值；
 *  · 不接受任何 CSS 函数、var() 引用或自由字符串：颜色只收 #RRGGBB，透明度走结构化 alpha，
 *    字体与圆角只收枚举档位；
 *  · 所有数值有范围，未知字段一律拒绝（.strict()）。
 * 缺省的键 = 继承基础层，不继承 default 包的 tokens（基础层本来就在 CSS 里，不搬进数据库）。
 */

/** 22 个语义色键：与 semantic.css 的同名变量一一对应，渲染时输出 `--<键>` */
export const COLOR_KEYS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
  "success",
  "warning",
  "info",
  "border",
  "input",
  "ring",
] as const;
export type ColorKey = (typeof COLOR_KEYS)[number];

/** 圆角档位：none 为直角，其余对应原子令牌 --fw-radius-<档> */
export const RADIUS_STEPS = ["none", "sm", "md", "lg", "xl"] as const;
export type RadiusStep = (typeof RADIUS_STEPS)[number];

/** 展示字体档位：只枚举系统字体栈，不做字体文件上传（docs/THEME-AUTHORING.md §8） */
export const DISPLAY_FONTS = ["system", "songti", "serif"] as const;
export type DisplayFont = (typeof DISPLAY_FONTS)[number];

const degreesSchema = z.number().int().min(0).max(359);

/** 阴影：偏移 / 模糊 / 扩展为整数 px，颜色 #RRGGBB + 结构化 alpha（不接受 css 函数） */
export const shadowSchema = z
  .object({
    x: z.number().int().min(-64).max(64),
    y: z.number().int().min(-64).max(64),
    blur: z.number().int().min(0).max(80),
    spread: z.number().int().min(-32).max(32),
    color: hexColorSchema,
    alpha: alphaSchema,
  })
  .strict();

/** 板块卡参数：宽度 rem（最多两位小数）、遮罩角度 / 渐隐带宽 / 整体压暗透明度、遮罩开关与可选遮罩色 */
export const bandSchema = z
  .object({
    width: z
      .number()
      .min(0)
      .max(16)
      .refine(
        (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8,
        "最多保留两位小数",
      ),
    angle: degreesSchema,
    fade: z.number().int().min(0).max(100),
    dim: alphaSchema,
    mask: z.boolean(),
    maskColor: hexColorSchema.optional(),
  })
  .strict();

export const tokenSetSchema = z
  .object({
    colors: z.partialRecord(z.enum(COLOR_KEYS), hexColorSchema).optional(),
    radius: z.enum(RADIUS_STEPS).optional(),
    shadows: z
      .object({
        s1: shadowSchema.optional(),
        s2: shadowSchema.optional(),
        s3: shadowSchema.optional(),
      })
      .strict()
      .optional(),
    displayFont: z.enum(DISPLAY_FONTS).optional(),
    brandGradient: z
      .object({ angle: degreesSchema, from: hexColorSchema, to: hexColorSchema })
      .strict()
      .optional(),
    band: bandSchema.optional(),
  })
  .strict();

/** `tokens` 段：浅色档与深色档都可选。深色档缺省 = 本包仅浅色，深色模式回退基础层的深色（与现状一致） */
export const tokensSchema = z
  .object({
    light: tokenSetSchema.optional(),
    dark: tokenSetSchema.optional(),
  })
  .strict();

export type Shadow = z.infer<typeof shadowSchema>;
export type TokenSet = z.infer<typeof tokenSetSchema>;
export type ThemePackTokens = z.infer<typeof tokensSchema>;
