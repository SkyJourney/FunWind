import { handleEmojiRequest } from "@/lib/emoji-serving";

/** /emoji/{id}.{ext}：解析、安全响应头与输出见 lib/emoji-serving.ts（旧 50 枚走 public 静态，路由只兜底新表情） */
export async function GET(req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  return handleEmojiRequest(req, file ?? "");
}
