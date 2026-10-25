/**
 * 按需缩略图（M6.4c，设计稿 §8）。`/files/<key>?w=` 的白名单宽度之一时，返回与原图同格式的缩略图。
 *
 * 缓存：STORAGE_DIR/.cache/thumbs/<sha>-<w>.<ext>，可随时整体清空，不入库。
 * 鉴权不在这里做：调用方（file-serving）先按原图完成鉴权，缓存命中也必须先鉴权（缓存文件名不含任何观众信息）。
 * 写入：先写同目录的临时文件再 rename，并发请求同一缩略图时最后一个 rename 胜出，内容相同。
 */
import { randomBytes } from "node:crypto";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { MAX_PIXELS } from "./types";

/** 支持缩略图的 MIME（GIF 动图缩放会丢动画，BMP 无法写出：一律返回原图） */
const THUMB_EXT: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function isThumbable(mime: string): boolean {
  return mime in THUMB_EXT;
}

/** 缩略图缓存路径；不支持的 MIME 返回 null */
export function thumbCachePath(
  storageDir: string,
  sha256: string,
  mime: string,
  width: number,
): string | null {
  const ext = THUMB_EXT[mime];
  if (!ext) return null;
  return path.join(storageDir, ".cache", "thumbs", `${sha256}-${width}.${ext}`);
}

/**
 * 确保缩略图存在并返回其路径。生成失败返回 null（调用方回退为原图，不把错误暴露给观众）。
 * 只缩小不放大（withoutEnlargement）；同格式输出；按 EXIF 定向（原图已去元数据，此处仅为稳妥）。
 */
export async function ensureThumb(
  storageDir: string,
  originalPath: string,
  sha256: string,
  mime: string,
  width: number,
): Promise<string | null> {
  const target = thumbCachePath(storageDir, sha256, mime, width);
  if (target === null) return null;
  try {
    await stat(target);
    return target;
  } catch {
    // 不存在：生成
  }
  try {
    await mkdir(path.dirname(target), { recursive: true });
    let pipeline = sharp(originalPath, { limitInputPixels: MAX_PIXELS })
      .rotate()
      .resize({ width, fit: "inside", withoutEnlargement: true });
    if (mime === "image/jpeg") pipeline = pipeline.jpeg({ quality: 85 });
    else if (mime === "image/png") pipeline = pipeline.png();
    else pipeline = pipeline.webp({ quality: 85 });
    const bytes = await pipeline.toBuffer();
    const tmp = `${target}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, target);
    return target;
  } catch (e) {
    console.error(`[files] 缩略图生成失败，回退原图: ${sha256} w=${width}`, e);
    return null;
  }
}
