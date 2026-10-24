import { getCurrentSubject } from "@/lib/authz/subject";
import { handleFileRequest } from "@/lib/file-serving";

/** /files/<storage_key>：鉴权、响应头与流式输出见 lib/file-serving.ts（取代旧的公开静态 /attachment/**） */
export async function GET(req: Request, { params }: { params: Promise<{ key: string[] }> }) {
  const { key } = await params;
  return handleFileRequest(req, key ?? [], await getCurrentSubject());
}
