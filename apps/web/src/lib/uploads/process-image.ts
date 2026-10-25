/**
 * 图片处理（M6.4a，设计稿 §7）：解码校验 → EXIF 自动定向 → 可选裁剪 → 同格式重编码（去除元数据）。
 *
 * 要点：
 *  - 先 rotate() 再 extract()：浏览器显示的是已定向的图，前端坐标基于它，服务端必须同一坐标系；
 *  - 不调用 withMetadata：输出不含 EXIF / GPS（设计稿要求，测试断言）；
 *  - limitInputPixels 限制解码前像素数（防解压炸弹）；另在 metadata 层显式检查一次，给出明确错误码；
 *  - GIF 不重编码（动图；只校验可解码）。头像使用 GIF 时取首帧并居中裁成正方形（GIF 不接受手动裁剪）；
 *  - bmp 无法由 sharp 写出，输出为 png。
 * 纯 I/O 边界只在 sharp 调用处，输入输出都是 Buffer。
 */
import sharp, { type Metadata, type OutputInfo } from "sharp";
import { validateCrop, type CropRect } from "./crop";
import { AVATAR_SIZE, MAX_PIXELS, MIME_OF, type SniffedType } from "./types";

export type ProcessErrorCode = "undecodable" | "pixels" | "gif_crop" | "crop_invalid";

/** 处理失败：路由据 code 映射 HTTP 状态（pixels → 413，其余 → 400） */
export class ProcessError extends Error {
  constructor(
    readonly code: ProcessErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProcessError";
  }
}

export interface ProcessOptions {
  /** 嗅探得到的图片类型（非图片不进入这里） */
  sniffed: SniffedType;
  /** 裁剪参数（已解析的 JSON 值）；缺省表示不裁剪 */
  crop?: unknown;
  /** 头像模式：输出 AVATAR_SIZE 正方形 webp，必须裁剪（GIF 除外，见文件头说明） */
  avatar?: boolean;
  /** 像素上限，默认 MAX_PIXELS（测试可覆盖以避免生成大图） */
  maxPixels?: number;
}

export interface ProcessedImage {
  bytes: Buffer;
  /** 输出的真实类型（决定存储扩展名与 MIME） */
  sniffed: SniffedType;
  mime: string;
  width: number;
  height: number;
}

/** EXIF 方向 5–8 表示宽高对调（旋转 90°） */
const swapsAxes = (orientation: number | undefined): boolean => (orientation ?? 1) >= 5;

function classify(e: unknown): ProcessError {
  const msg = e instanceof Error ? e.message : String(e);
  if (/pixel limit/i.test(msg)) return new ProcessError("pixels", "图片尺寸过大");
  return new ProcessError("undecodable", "无法解码图片");
}

export async function processImage(input: Buffer, opts: ProcessOptions): Promise<ProcessedImage> {
  const maxPixels = opts.maxPixels ?? MAX_PIXELS;
  if (opts.sniffed === "gif") return processGif(input, opts, maxPixels);

  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: maxPixels }).metadata();
  } catch (e) {
    throw classify(e);
  }
  const rawW = meta.width ?? 0;
  const rawH = meta.height ?? 0;
  if (rawW <= 0 || rawH <= 0) throw new ProcessError("undecodable", "无法读取图片尺寸");
  if (rawW * rawH > maxPixels) throw new ProcessError("pixels", "图片尺寸过大");

  const oriented = swapsAxes(meta.orientation)
    ? { width: rawH, height: rawW }
    : { width: rawW, height: rawH };

  let crop: CropRect | null = null;
  if (opts.crop !== undefined && opts.crop !== null) {
    const checked = validateCrop(opts.crop, oriented, { square: opts.avatar === true });
    if (!checked.ok) throw new ProcessError("crop_invalid", checked.reason);
    crop = checked.crop;
  }
  if (opts.avatar === true && crop === null) {
    throw new ProcessError("crop_invalid", "头像必须裁剪");
  }

  // 先定向再裁剪：rotate() 必须位于 extract() 之前
  let pipeline = sharp(input, { limitInputPixels: maxPixels }).rotate();
  if (crop !== null) {
    // sharp 的 extract 用 left/top，校验后的 x/y 在这里映射
    pipeline = pipeline.extract({
      left: crop.x,
      top: crop.y,
      width: crop.width,
      height: crop.height,
    });
  }

  let outType: SniffedType;
  if (opts.avatar === true) {
    outType = "webp";
    pipeline = pipeline.resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover" }).webp({ quality: 90 });
  } else if (opts.sniffed === "jpeg") {
    outType = "jpeg";
    pipeline = pipeline.jpeg({ quality: 90 });
  } else if (opts.sniffed === "webp") {
    outType = "webp";
    pipeline = pipeline.webp({ quality: 90 });
  } else {
    // png 与 bmp（bmp 无法写出，统一为 png）
    outType = "png";
    pipeline = pipeline.png();
  }

  let out: { data: Buffer; info: OutputInfo };
  try {
    out = await pipeline.toBuffer({ resolveWithObject: true });
  } catch (e) {
    throw classify(e);
  }
  return {
    bytes: out.data,
    sniffed: outType,
    mime: MIME_OF[outType],
    width: out.info.width,
    height: out.info.height,
  };
}

async function processGif(
  input: Buffer,
  opts: ProcessOptions,
  maxPixels: number,
): Promise<ProcessedImage> {
  let meta: Metadata;
  try {
    // pages: 1 只解码首帧，既用于校验，也用于头像
    meta = await sharp(input, { limitInputPixels: maxPixels, pages: 1 }).metadata();
  } catch (e) {
    throw classify(e);
  }
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (w <= 0 || h <= 0) throw new ProcessError("undecodable", "无法读取图片尺寸");
  if (w * h > maxPixels) throw new ProcessError("pixels", "图片尺寸过大");

  if (opts.avatar !== true) {
    if (opts.crop !== undefined && opts.crop !== null) {
      throw new ProcessError("gif_crop", "GIF 不支持裁剪");
    }
    // 非头像：原样存储（不重编码，保留动画）
    return { bytes: input, sniffed: "gif", mime: MIME_OF.gif, width: w, height: h };
  }

  // 头像：首帧居中裁成正方形，输出 webp
  if (opts.crop !== undefined && opts.crop !== null) {
    throw new ProcessError("gif_crop", "GIF 头像不支持手动裁剪");
  }
  const side = Math.min(w, h);
  const left = Math.floor((w - side) / 2);
  const top = Math.floor((h - side) / 2);
  let out: { data: Buffer; info: OutputInfo };
  try {
    out = await sharp(input, { limitInputPixels: maxPixels, pages: 1 })
      .extract({ left, top, width: side, height: side })
      .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover" })
      .webp({ quality: 90 })
      .toBuffer({ resolveWithObject: true });
  } catch (e) {
    throw classify(e);
  }
  return {
    bytes: out.data,
    sniffed: "webp",
    mime: MIME_OF.webp,
    width: out.info.width,
    height: out.info.height,
  };
}
