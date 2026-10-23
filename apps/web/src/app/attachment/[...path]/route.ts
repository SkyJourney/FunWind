import { createReadStream, promises as fs } from "node:fs";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { contentDispositionFor, resolveStaticPath } from "@/lib/static-files";

/**
 * /attachment/** → 旧站附件目录（基线审查约定：路径原样保留，静态直出）。
 * 安全：逐段穿越守卫 + resolve 前缀校验（见 lib/static-files.ts）。
 */
export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path: segments } = await params;
  const base = process.env.ATTACHMENT_DIR;
  if (!base) return new NextResponse("attachment dir not configured", { status: 500 });

  const file = resolveStaticPath(base, segments ?? []);
  if (!file) return new NextResponse("not found", { status: 404 });

  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return new NextResponse("not found", { status: 404 });
    const { type, inline } = contentDispositionFor(file);
    const stream = Readable.toWeb(createReadStream(file)) as ReadableStream;
    return new NextResponse(stream, {
      headers: {
        "content-type": type,
        "content-length": String(stat.size),
        "cache-control": "public, max-age=31536000, immutable",
        "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.split("/").pop() ?? "file")}`,
      },
    });
  } catch {
    return new NextResponse("not found", { status: 404 });
  }
}
