import { getCurrentSubject } from "@/lib/authz/subject";
import { handleFileRequest } from "@/lib/file-serving";

/** /files/<storage_key>：鉴权、响应头与流式输出见 lib/file-serving.ts（取代旧的公开静态 /attachment/**）
 *  畸形 URL（超长 UTF-8 等）由 proxy 层拦截成 404——Next 在调用 handler 前解析 params，
 *  解码异常到不了 handler 内的 try（M9.5 CI 全量迁移时暴露）。 */
export async function GET(req: Request, { params }: { params: Promise<{ key: string[] }> }) {
  const { key } = await params;
  return handleFileRequest(req, key ?? [], await getCurrentSubject());
}
