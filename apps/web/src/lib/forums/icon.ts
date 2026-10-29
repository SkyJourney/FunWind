import { stat } from "node:fs/promises";
import { STORED_EXT, type SniffedType } from "@/lib/uploads/types";
import { sniffType } from "@/lib/uploads/sniff";
import { processImage, ProcessError } from "@/lib/uploads/process-image";
import { sha256Hex, writeContentAddressed } from "@/lib/uploads/store";
import { storageKeyFor } from "@/lib/uploads/policy";

/**
 * 板块图上传处理（M9.5 §3.4，schema v2.4 forums.icon_key）：嗅探不信扩展名 → 复用 lib/uploads
 * 管线（png/jpeg/webp 重编码去元数据）→ 尺寸 / 字节上限 → 内容寻址落盘。
 * files 表登记与 forums.icon_key 写入、审计在调用方事务里做。
 *
 * 上限是代码内常量（同 M10.9 表情做法）：≤ 512×512 像素、≤ 300 KB；只接受 png / jpeg / webp。
 * 旧站 32 枚板块图（165×100 JPEG）由迁移器原字节直存，不走本管线。
 */

const ICON_MAX_EDGE = 512;
const ICON_MAX_BYTES = 300 * 1024;

const ICON_TYPES: ReadonlySet<SniffedType> = new Set(["png", "jpeg", "webp"]);

export type ForumIconResult =
  | {
      ok: true;
      sha256: string;
      storageKey: string;
      width: number;
      height: number;
      /** 处理后字节数（files.size_bytes） */
      sizeBytes: number;
      ext: "png" | "jpg" | "webp";
    }
  | { ok: false; code: "empty" | "type" | "size" | "bytes" | "undecodable"; message: string };

export async function processForumIcon(
  input: Buffer,
  storageDir: string,
): Promise<ForumIconResult> {
  if (input.byteLength === 0) {
    return { ok: false, code: "empty", message: "文件内容为空" };
  }
  const sniffed = sniffType(input);
  if (sniffed === null || !ICON_TYPES.has(sniffed)) {
    return {
      ok: false,
      code: "type",
      message: `不支持的格式：板块图只接受 PNG / JPG / WebP（收到 ${
        sniffed === null ? "无法识别的类型" : sniffed.toUpperCase()
      }）`,
    };
  }
  let processed;
  try {
    processed = await processImage(input, { sniffed });
  } catch (e) {
    if (e instanceof ProcessError) {
      return {
        ok: false,
        code: e.code === "pixels" ? "size" : "undecodable",
        message: e.code === "pixels" ? "图片尺寸过大" : "无法解码图片（文件损坏或伪装）",
      };
    }
    throw e;
  }
  if (processed.width > ICON_MAX_EDGE || processed.height > ICON_MAX_EDGE) {
    return {
      ok: false,
      code: "size",
      message: `尺寸超限：${processed.width}×${processed.height}，上限 ${ICON_MAX_EDGE}×${ICON_MAX_EDGE} 像素`,
    };
  }
  if (processed.bytes.byteLength > ICON_MAX_BYTES) {
    return {
      ok: false,
      code: "bytes",
      message: `文件超限：${(processed.bytes.byteLength / 1024).toFixed(0)}KB，上限 ${
        ICON_MAX_BYTES / 1024
      }KB`,
    };
  }

  const sha256 = sha256Hex(processed.bytes);
  const storageKey = storageKeyFor(sha256, processed.sniffed);
  const finalPath = `${storageDir}/${storageKey}`;
  let onDisk = false;
  try {
    onDisk = (await stat(finalPath)).isFile();
  } catch {
    onDisk = false;
  }
  if (!onDisk) await writeContentAddressed(storageDir, storageKey, processed.bytes);

  return {
    ok: true,
    sha256,
    storageKey,
    width: processed.width,
    height: processed.height,
    sizeBytes: processed.bytes.byteLength,
    ext: STORED_EXT[processed.sniffed] as "png" | "jpg" | "webp",
  };
}
