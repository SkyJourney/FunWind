/**
 * 裁剪参数的校验（M6.4a，设计稿 §7、D10）。
 * 坐标为「自然像素」：基于 EXIF 已定向的图片尺寸（服务端先 rotate() 再 extract，两端坐标系一致）。
 * 纯函数，无 I/O；前端传来的 JSON 一律先经这里校验，失败不进入 sharp。
 */
import { MIN_CROP } from "./types";

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type CropCheck = { ok: true; crop: CropRect } | { ok: false; reason: string };

/**
 * 校验裁剪矩形：整数、非负、最小边长、不越界；头像另需 1:1。
 * size 是已定向后的图片尺寸（调用方负责把 EXIF 方向 5–8 的宽高对调）。
 */
export function validateCrop(
  input: unknown,
  size: { width: number; height: number },
  opts: { square: boolean },
): CropCheck {
  if (typeof input !== "object" || input === null) return { ok: false, reason: "crop 必须是对象" };
  const o = input as Record<string, unknown>;
  const fields = ["x", "y", "width", "height"] as const;
  for (const f of fields) {
    const v = o[f];
    if (typeof v !== "number" || !Number.isInteger(v))
      return { ok: false, reason: `${f} 必须是整数` };
  }
  const { x, y, width, height } = o as unknown as CropRect;
  if (x < 0 || y < 0) return { ok: false, reason: "x、y 不能为负" };
  if (width < MIN_CROP || height < MIN_CROP)
    return { ok: false, reason: `裁剪边长不能小于 ${MIN_CROP}` };
  if (x + width > size.width || y + height > size.height)
    return { ok: false, reason: "裁剪区域超出图片" };
  if (opts.square && width !== height) return { ok: false, reason: "头像必须为 1:1 裁剪" };
  return { ok: true, crop: { x, y, width, height } };
}

/** 表单 crop 字段的解析结果：none = 未提供（不裁剪）；invalid = 不是合法 JSON */
export type CropField = { kind: "none" } | { kind: "value"; value: unknown } | { kind: "invalid" };

/** 解析表单里的 crop 字段（JSON 字符串）。空串或缺失视为不裁剪 */
export function parseCropField(raw: string | null | undefined): CropField {
  if (raw === undefined || raw === null || raw === "") return { kind: "none" };
  try {
    return { kind: "value", value: JSON.parse(raw) as unknown };
  } catch {
    return { kind: "invalid" };
  }
}
