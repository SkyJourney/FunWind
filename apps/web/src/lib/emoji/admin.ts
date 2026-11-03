import { processImageAsset, type ImageAssetResult } from "@/lib/uploads/image-asset";

/**
 * 社区表情上传：只接受透明与动画常用格式；GIF 不重编码，其余去元数据后按最终尺寸与字节限额检查。
 * 文件登记、表情写入及审计由调用方事务负责；同内容可复用存储键创建不同名字。
 */
export const EMOJI_MAX_EDGE = 200;
export const EMOJI_MAX_BYTES = 200 * 1024;
const EMOJI_MIME_TYPES: ReadonlySet<string> = new Set(["image/png", "image/gif", "image/webp"]);

export type EmojiUploadResult = ImageAssetResult;

/** 处理并幂等落盘表情，失败码与中文提示直接交给后台展示。 */
export async function processEmojiUpload(
  input: Buffer,
  storageDir: string,
): Promise<EmojiUploadResult> {
  return processImageAsset(input, {
    storageDir,
    allowedMimeTypes: EMOJI_MIME_TYPES,
    typeLabel: "表情只接受 PNG / GIF / WebP",
    maxEdge: EMOJI_MAX_EDGE,
    maxBytes: EMOJI_MAX_BYTES,
  });
}
