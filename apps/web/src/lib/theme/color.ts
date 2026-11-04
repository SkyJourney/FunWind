import { z } from "zod";

/**
 * 颜色与透明度的基础 schema（从 surface-schema.ts 抽出）。
 * 语义令牌 schema（token-schema.ts）要用它们，而 surface-schema.ts 又要引用令牌 schema，
 * 放在 surface-schema.ts 里会形成循环依赖。
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

/**
 * #RRGGBB → [r, g, b]（各 0–255）。
 * 调用方须先经 hexColorSchema 校验；非法输入抛错而不是返回垃圾值，错误信息不回显输入。
 */
export function hexToRgb(hex: string): [number, number, number] {
  const match = /^#([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})$/.exec(hex);
  if (!match) throw new Error("非法颜色（须 #RRGGBB）");
  return [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)];
}
