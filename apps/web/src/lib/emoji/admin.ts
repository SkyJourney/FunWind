import { stat } from "node:fs/promises";
import { MIME_OF, STORED_EXT, type SniffedType } from "@/lib/uploads/types";
import { sniffType } from "@/lib/uploads/sniff";
import { processImage, ProcessError } from "@/lib/uploads/process-image";
import { storageKeyFor } from "@/lib/uploads/policy";
import { sha256Hex, writeContentAddressed } from "@/lib/uploads/store";

/**
 * 社区表情的上传处理（M10.9，设计稿 §2.3）：嗅探不信扩展名 → 复用 lib/uploads 管线（GIF 不重编码）→
 * 尺寸 / 字节上限 → 内容寻址落盘。库登记（files + emojis）与审计在调用方的事务里做。
 *
 * 上限是代码内常量（站长拍板）：≤ 200×200 像素、≤ 200 KB；只接受 png / gif / webp
 * （表情需要透明与动画；jpeg / bmp 拒收并给可读提示）。同一文件内容天然去重（storage_key 相同）。
 */

export const EMOJI_MAX_EDGE = 200;
export const EMOJI_MAX_BYTES = 200 * 1024;

/** 表情接受的类型：不含 jpeg（不透明、不需要）与 bmp（sharp 无法写出） */
const EMOJI_TYPES: ReadonlySet<SniffedType> = new Set(["png", "gif", "webp"]);

export type EmojiUploadResult =
  | {
      ok: true;
      sha256: string;
      storageKey: string;
      /** URL 扩展名（= STORED_EXT[sniffed]，表情域内恰为 png/gif/webp） */
      ext: string;
      mime: string;
      width: number;
      height: number;
      sizeBytes: number;
    }
  | { ok: false; code: "empty" | "type" | "undecodable" | "size" | "bytes"; message: string };

/**
 * 处理并落盘一个表情文件。全部拒绝都带中文 message（直接展示给站长）；
 * 成功返回内容寻址结果。文件已在盘上（幂等：同内容不重写），失败的中间态只剩可被 gc 巡检的临时文件。
 */
export async function processEmojiUpload(
  input: Buffer,
  storageDir: string,
): Promise<EmojiUploadResult> {
  if (input.byteLength === 0) {
    return { ok: false, code: "empty", message: "文件内容为空" };
  }
  const sniffed = sniffType(input);
  if (sniffed === null || !EMOJI_TYPES.has(sniffed)) {
    return {
      ok: false,
      code: "type",
      message: `不支持的格式：表情只接受 PNG / GIF / WebP（收到 ${
        sniffed === null ? "无法识别的类型" : sniffed.toUpperCase()
      }）`,
    };
  }

  // 管线复用：png/webp 重编码去元数据；gif 只校验可解码、不重编码（保动画）
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

  if (processed.width > EMOJI_MAX_EDGE || processed.height > EMOJI_MAX_EDGE) {
    return {
      ok: false,
      code: "size",
      message: `尺寸超限：${processed.width}×${processed.height}，上限 ${EMOJI_MAX_EDGE}×${EMOJI_MAX_EDGE} 像素`,
    };
  }
  if (processed.bytes.byteLength > EMOJI_MAX_BYTES) {
    return {
      ok: false,
      code: "bytes",
      message: `文件超限：${(processed.bytes.byteLength / 1024).toFixed(0)}KB，上限 ${
        EMOJI_MAX_BYTES / 1024
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
    ext: STORED_EXT[processed.sniffed],
    mime: processed.mime || MIME_OF[processed.sniffed],
    width: processed.width,
    height: processed.height,
    sizeBytes: processed.bytes.byteLength,
  };
}
