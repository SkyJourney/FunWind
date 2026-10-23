import { createReadStream, promises as fs } from "node:fs";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { resolveStaticPath } from "@/lib/static-files";

/** /emotion/** → 旧站表情目录（[s:N] 表情图渲染数据源；穿越守卫同 attachment） */
export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path: segments } = await params;
  const base = process.env.EMOTION_DIR;
  if (!base) return new NextResponse("emotion dir not configured", { status: 500 });

  const file = resolveStaticPath(base, segments ?? []);
  if (!file) return new NextResponse("not found", { status: 404 });

  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return new NextResponse("not found", { status: 404 });
    const stream = Readable.toWeb(createReadStream(file)) as ReadableStream;
    return new NextResponse(stream, {
      headers: {
        "content-type": "image/gif",
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new NextResponse("not found", { status: 404 });
  }
}
