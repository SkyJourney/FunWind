import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { requireAdmin } from "@/lib/authz/require-admin";

export const dynamic = "force-dynamic";

/**
 * 备份文件下载（M13 追加运维功能，site.admin）：从备份卷（只读挂载 BACKUP_FILES_DIR）
 * 流式返回指定备份文件。防目录穿越：realpath 必须落在备份目录内，且仅允许 .gz/.tgz。
 */
export async function GET(request: Request) {
  await requireAdmin("site.admin");
  const url = new URL(request.url);
  const rel = url.searchParams.get("path") ?? "";
  const base = process.env.BACKUP_FILES_DIR ?? "";
  if (!base) return new Response("备份卷未配置（BACKUP_FILES_DIR）", { status: 503 });

  const resolved = path.resolve(base, "." + (rel.startsWith("/") ? rel : "/" + rel));
  if (!resolved.startsWith(path.resolve(base) + path.sep) || !/\.(sql\.gz|tgz)$/.test(resolved)) {
    return new Response("非法路径", { status: 400 });
  }
  try {
    const info = await stat(resolved);
    if (!info.isFile()) return new Response("not found", { status: 404 });
    const bytes = await readFile(resolved);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": "application/gzip",
        "content-length": String(bytes.byteLength),
        "content-disposition": `attachment; filename="${path.basename(resolved)}"`,
        "cache-control": "private, no-store",
      },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
