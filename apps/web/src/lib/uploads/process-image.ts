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
    // 非头像：不重编码（保留动画），但去除注释、文本与非动画的应用扩展块（它们可能携带作者信息）
    return {
      bytes: stripGifAncillary(input),
      sniffed: "gif",
      mime: MIME_OF.gif,
      width: w,
      height: h,
    };
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

/** GIF 中保留的扩展块：图形控制（动画时序）与循环信息（NETSCAPE2.0 / ANIMEXTS1.0） */
const GIF_KEEP_APP_IDS = new Set(["NETSCAPE2.0", "ANIMEXTS1.0"]);

/**
 * 去除 GIF 中的注释块、纯文本块与非动画的应用扩展块（如 XMP）；图像数据与动画时序原样保留。
 * 按 GIF 块结构逐块解析，任何越界或未知块都抛出 undecodable，不做「尽力而为」的截取。
 */
export function stripGifAncillary(input: Buffer): Buffer {
  const fail = (): never => {
    throw new ProcessError("undecodable", "GIF 结构异常");
  };
  if (input.length < 13) fail();
  const out: Buffer[] = [];
  // 头部 6 字节 + 逻辑屏幕描述符 7 字节（打包字段第 10 字节：bit7 = 全局色表，低 3 位 = 大小）
  let pos = 13;
  const packed0 = input[10]!;
  if (packed0 & 0x80) pos += 3 * 2 ** ((packed0 & 0x07) + 1);
  out.push(input.subarray(0, pos));

  // 跳过一串子块（长度字节 + 数据，以 0 结束）；返回结束后的位置
  const skipSubBlocks = (start: number): number => {
    let p = start;
    for (;;) {
      if (p >= input.length) fail();
      const n = input[p]!;
      p += 1;
      if (n === 0) return p;
      p += n;
      if (p > input.length) fail();
    }
  };

  for (;;) {
    if (pos >= input.length) fail();
    const b = input[pos]!;
    if (b === 0x3b) {
      out.push(input.subarray(pos, pos + 1));
      break;
    }
    if (b === 0x21) {
      // 扩展块：0x21 + 标签 + 子块序列
      if (pos + 2 > input.length) fail();
      const label = input[pos + 1]!;
      const end = skipSubBlocks(pos + 2);
      let keep = label === 0xf9; // 图形控制
      if (label === 0xff) {
        // 应用扩展：第一个子块是 11 字节的应用标识
        const idLen = input[pos + 2];
        const id = idLen === 11 ? input.subarray(pos + 3, pos + 14).toString("latin1") : "";
        keep = GIF_KEEP_APP_IDS.has(id);
      }
      if (keep) out.push(input.subarray(pos, end));
      pos = end;
      continue;
    }
    if (b === 0x2c) {
      // 图像块：0x2C + 9 字节描述符（打包字段在第 9 字节）+ 可选局部色表 + LZW 最小码长 + 子块
      if (pos + 10 > input.length) fail();
      const packed = input[pos + 9]!;
      let p = pos + 10;
      if (packed & 0x80) p += 3 * 2 ** ((packed & 0x07) + 1);
      if (p >= input.length) fail();
      p += 1; // LZW 最小码长
      const end = skipSubBlocks(p);
      out.push(input.subarray(pos, end));
      pos = end;
      continue;
    }
    fail();
  }
  return Buffer.concat(out);
}
