/**
 * 裁剪坐标换算（M6.4d2）：把裁剪框在屏幕上的显示坐标换算为图片的自然像素（整数），交给服务端 extract。
 * 浏览器显示的是已按 EXIF 定向的图，naturalWidth / naturalHeight 也是定向后的尺寸，与服务端 rotate() 后的坐标系一致。
 * 纯函数，无 DOM：可以直接单测。
 */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** 与服务端 MIN_CROP 保持一致（lib/uploads/types.ts） */
export const MIN_SIDE = 32;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * 显示坐标 → 自然像素。结果保证：整数、x/y ≥ 0、不越出图片、边长 ≥ MIN_SIDE；square 时为正方形（取较小边）。
 * 太小或完全越界返回 null（调用方提示用户重新框选）。
 */
export function toNaturalCrop(
  display: Box,
  displaySize: Size,
  natural: Size,
  opts: { square: boolean },
): Box | null {
  if (displaySize.width <= 0 || displaySize.height <= 0) return null;
  const sx = natural.width / displaySize.width;
  const sy = natural.height / displaySize.height;
  const x = clamp(Math.round(display.x * sx), 0, natural.width - 1);
  const y = clamp(Math.round(display.y * sy), 0, natural.height - 1);
  let width = Math.round(display.width * sx);
  let height = Math.round(display.height * sy);
  if (opts.square) {
    const side = Math.min(width, height);
    width = side;
    height = side;
  }
  width = Math.min(width, natural.width - x);
  height = Math.min(height, natural.height - y);
  if (opts.square) {
    const side = Math.min(width, height);
    width = side;
    height = side;
  }
  if (width < MIN_SIDE || height < MIN_SIDE) return null;
  return { x, y, width, height };
}

/** 初始裁剪框：图片中央的最大正方形（头像默认选区） */
export function centeredSquare(natural: Size): Box {
  const side = Math.min(natural.width, natural.height);
  return {
    x: Math.floor((natural.width - side) / 2),
    y: Math.floor((natural.height - side) / 2),
    width: side,
    height: side,
  };
}
