/**
 * 上传的准入规则（M6.4a）：扩展名白名单、扩展名与嗅探类型一致、用途允许的类型、文件名清洗。
 * 纯函数。路由（M6.4b）先嗅探，再调用这里决定放行或拒绝；拒绝一律 415（类型）或 400（文件名）。
 */
import {
  EXTENSION_TYPES,
  PURPOSE_TYPES,
  STORED_EXT,
  type SniffedType,
  type UploadPurpose,
} from "./types";

export type AdmitResult =
  | { ok: true }
  | {
      ok: false;
      code: "no_extension" | "extension_not_allowed" | "type_mismatch" | "purpose_type";
    };

/** 取文件名的小写扩展名（无扩展名返回 null）。只看最后一个点之后的部分 */
export function extensionOf(name: string): string | null {
  const base = name.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return null;
  return base.slice(dot + 1).toLowerCase();
}

/**
 * 准入判定：
 *  1. 扩展名必须在白名单内（svg、html、js、php 等一律不在其中）；
 *  2. 扩展名对应的类型必须与嗅探到的真实类型一致（伪装拦截：php 内容改名为 .jpg 时 sniff 为 txt，不一致即拒绝）；
 *  3. 真实类型必须被该用途允许（inline / avatar 只收图片）。
 * 存储扩展名由 STORED_EXT[sniffed] 决定，不沿用用户扩展名（jpeg 统一存为 jpg）。
 */
export function admit(name: string, purpose: UploadPurpose, sniffed: SniffedType): AdmitResult {
  const ext = extensionOf(name);
  if (ext === null) return { ok: false, code: "no_extension" };
  const declared = EXTENSION_TYPES[ext];
  if (declared === undefined) return { ok: false, code: "extension_not_allowed" };
  if (declared !== sniffed) return { ok: false, code: "type_mismatch" };
  if (!PURPOSE_TYPES[purpose].has(sniffed)) return { ok: false, code: "purpose_type" };
  return { ok: true };
}

/** 文件名清洗：去路径、去控制字符、去首尾空白、截断到 255 个码点；空名退化为 download */
export function sanitizeOriginalName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (cleaned === "") return "download";
  return Array.from(cleaned).slice(0, 255).join("");
}

/** 内容寻址的存储键：ab/cd/<sha256>.<ext>，与 /files 路由的 parseFileKey 同一形态 */
export function storageKeyFor(sha256: string, sniffed: SniffedType): string {
  return `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}.${STORED_EXT[sniffed]}`;
}
