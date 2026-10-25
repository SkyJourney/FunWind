/**
 * 魔数嗅探（M6.4a）。只看字节，不看扩展名与客户端声明的 Content-Type。
 * 嗅探结果决定存储扩展名与 MIME；与用户扩展名不一致的文件在 policy.ts 中拒绝。
 */
import type { SniffedType } from "./types";

const ascii = (buf: Uint8Array, offset: number, text: string): boolean => {
  if (buf.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (buf[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
};

/** 在 buf 中查找子串（按字节比较，不做编码转换） */
const containsAscii = (buf: Uint8Array, text: string): boolean => {
  outer: for (let i = 0; i + text.length <= buf.length; i++) {
    for (let j = 0; j < text.length; j++) {
      if (buf[i + j] !== text.charCodeAt(j)) continue outer;
    }
    return true;
  }
  return false;
};

const u32le = (buf: Uint8Array, offset: number): number =>
  (buf[offset] ?? 0) |
  ((buf[offset + 1] ?? 0) << 8) |
  ((buf[offset + 2] ?? 0) << 16) |
  (((buf[offset + 3] ?? 0) << 24) >>> 0);

const bytes = (buf: Uint8Array, offset: number, list: readonly number[]): boolean => {
  if (buf.length < offset + list.length) return false;
  return list.every((b, i) => buf[offset + i] === b);
};

/** 纯文本：不含 NUL 且是有效的 UTF-8（允许 BOM）。整个文件参与判定 */
export function isPlainText(buf: Uint8Array): boolean {
  if (buf.length === 0) return false;
  if (buf.indexOf(0) !== -1) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * 嗅探真实类型。无法识别时返回 null（调用方以 415 拒绝）。
 * 图片类只做魔数判定；是否真能解码由 process-image.ts 的 sharp 再验证一次。
 */
export function sniffType(buf: Uint8Array): SniffedType | null {
  if (bytes(buf, 0, [0xff, 0xd8, 0xff])) return "jpeg";
  if (bytes(buf, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (ascii(buf, 0, "GIF87a") || ascii(buf, 0, "GIF89a")) return "gif";
  if (ascii(buf, 0, "RIFF") && ascii(buf, 8, "WEBP")) return "webp";
  // BMP 的两字节魔数太弱（以 BM 开头的文本很常见）：再核对头部记录的文件总长与保留字段，解码由 sharp 验证
  if (
    ascii(buf, 0, "BM") &&
    buf.length >= 26 &&
    u32le(buf, 2) === buf.length &&
    u32le(buf, 6) === 0
  ) {
    return "bmp";
  }
  if (bytes(buf, 0, [0x50, 0x4b, 0x03, 0x04]) || bytes(buf, 0, [0x50, 0x4b, 0x05, 0x06]))
    return "zip";
  if (bytes(buf, 0, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return "rar";
  if (bytes(buf, 0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return "7z";
  // 种子文件是 bencode 字典：以 'd' 开头，且含 info 字典的键
  if (buf[0] === 0x64 && containsAscii(buf, "4:info")) return "torrent";
  if (isPlainText(buf)) return "txt";
  return null;
}
