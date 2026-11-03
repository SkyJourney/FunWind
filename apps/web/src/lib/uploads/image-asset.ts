import "server-only";

import { stat } from "node:fs/promises";
import path from "node:path";
import {
  processImage,
  ProcessError,
  type ProcessOptions,
  type ProcessedImage,
} from "./process-image";
import { storageKeyFor } from "./policy";
import { sniffType } from "./sniff";
import { sha256Hex, writeContentAddressed } from "./store";
import { MIME_OF, STORED_EXT } from "./types";

export interface ImageAssetOptions {
  storageDir: string;
  allowedMimeTypes: ReadonlySet<string>;
  /** 格式拒绝时的领域提示，如「表情只接受 PNG / GIF / WebP」。 */
  typeLabel: string;
  maxEdge: number;
  /** 处理后字节上限；不会替代普通上传入口的原始字节上限。 */
  maxBytes: number;
  maxPixels?: number;
  /** 沿用解码器的裁剪与头像策略；GIF 保留动画，只有头像模式取首帧。 */
  reencode?: Pick<ProcessOptions, "crop" | "avatar">;
}

export type ImageAssetResult =
  | {
      ok: true;
      sha256: string;
      storageKey: string;
      ext: string;
      mime: string;
      width: number;
      height: number;
      sizeBytes: number;
    }
  | { ok: false; code: "empty" | "type" | "undecodable" | "size" | "bytes"; message: string };

/** 图片解码与重编码的唯一业务出口；普通上传保留自身准入、配额和原始字节限额顺序。 */
export async function processUploadImage(
  input: Buffer,
  opts: ProcessOptions,
): Promise<ProcessedImage> {
  return processImage(input, opts);
}

/** 素材上传：嗅探 → 去元数据 → 尺寸 → 最终字节 → 内容寻址，领域只提供限制与提示。 */
export async function processImageAsset(
  input: Buffer,
  opts: ImageAssetOptions,
): Promise<ImageAssetResult> {
  if (input.byteLength === 0) return { ok: false, code: "empty", message: "文件内容为空" };
  const sniffed = sniffType(input);
  if (sniffed === null || !opts.allowedMimeTypes.has(MIME_OF[sniffed])) {
    return {
      ok: false,
      code: "type",
      message: `不支持的格式：${opts.typeLabel}（收到 ${
        sniffed === null ? "无法识别的类型" : sniffed.toUpperCase()
      }）`,
    };
  }

  let processed: ProcessedImage;
  try {
    processed = await processUploadImage(input, {
      sniffed,
      maxPixels: opts.maxPixels,
      ...opts.reencode,
    });
  } catch (error) {
    if (!(error instanceof ProcessError)) throw error;
    return {
      ok: false,
      code: error.code === "pixels" ? "size" : "undecodable",
      message: error.code === "pixels" ? "图片尺寸过大" : "无法解码图片（文件损坏或伪装）",
    };
  }
  if (processed.width > opts.maxEdge || processed.height > opts.maxEdge) {
    return {
      ok: false,
      code: "size",
      message: `尺寸超限：${processed.width}×${processed.height}，上限 ${opts.maxEdge}×${opts.maxEdge} 像素`,
    };
  }
  if (processed.bytes.byteLength > opts.maxBytes) {
    return {
      ok: false,
      code: "bytes",
      message: `文件超限：${(processed.bytes.byteLength / 1024).toFixed(0)}KB，上限 ${
        opts.maxBytes / 1024
      }KB`,
    };
  }

  const sha256 = sha256Hex(processed.bytes);
  const storageKey = storageKeyFor(sha256, processed.sniffed);
  let onDisk = false;
  try {
    onDisk = (await stat(path.join(opts.storageDir, storageKey))).isFile();
  } catch {
    // 未命中内容寻址文件时才写入，保持重复上传的幂等行为。
  }
  if (!onDisk) await writeContentAddressed(opts.storageDir, storageKey, processed.bytes);
  return {
    ok: true,
    sha256,
    storageKey,
    ext: STORED_EXT[processed.sniffed],
    mime: processed.mime || MIME_OF[processed.sniffed],
    width: processed.width,
    height: processed.height,
    sizeBytes: processed.bytes.byteLength,
  };
}
