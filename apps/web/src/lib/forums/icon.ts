import { processImageAsset, type ImageAssetResult } from "@/lib/uploads/image-asset";

/**
 * 板块图上传：PNG / JPEG / WebP 去元数据后检查 ≤512×512、≤300KB，文件登记与板块写入由调用方事务负责。
 * 旧站板块图由迁移器原字节直存，不进入本管线。
 */
export const ICON_MAX_EDGE = 512;
export const ICON_MAX_BYTES = 300 * 1024;
const ICON_MIME_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp"]);

export type ForumIconResult =
  | (Extract<ImageAssetResult, { ok: true }> & { ext: "png" | "jpg" | "webp" })
  | Extract<ImageAssetResult, { ok: false }>;

/** 处理并幂等落盘板块图；真实 MIME 由解码结果决定，不再用 URL 扩展名反查。 */
export async function processForumIcon(
  input: Buffer,
  storageDir: string,
): Promise<ForumIconResult> {
  const result = await processImageAsset(input, {
    storageDir,
    allowedMimeTypes: ICON_MIME_TYPES,
    typeLabel: "板块图只接受 PNG / JPG / WebP",
    maxEdge: ICON_MAX_EDGE,
    maxBytes: ICON_MAX_BYTES,
  });
  if (!result.ok) return result;
  if (!isIconExtension(result.ext)) throw new Error("板块图管线输出了未允许的扩展名");
  return { ...result, ext: result.ext };
}

/** 用运行时白名单收窄扩展名，避免 JPEG 的 jpg / jpeg 差异被强转掩盖。 */
function isIconExtension(ext: string): ext is "png" | "jpg" | "webp" {
  return ext === "png" || ext === "jpg" || ext === "webp";
}
