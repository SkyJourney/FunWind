import { createReadStream, promises as fs } from "node:fs";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { emojis, getWebDb } from "@funwind/db";
import { parseFileKey } from "@/lib/file-serving";
import { resolveStaticPath } from "@/lib/static-files";
import { getStorageDir } from "@/lib/storage";

/**
 * /emoji/{id}.{ext} 提供路由的请求处理（M10.9，设计稿 §2.2）。路由文件只做薄薄一层，逻辑在 lib 以便脱离 Next 做集成测试。
 *
 * 旧 50 枚（id 120–169）是 public/emoji/{id}.gif 静态文件，Next 的静态资源优先于路由，本路由只兜底
 * 后台上传的新表情（storage_key 非空）。URL 是冻结约定（硬约定 8），已发布正文里的引用永远不能碎：
 *   · enabled=false 照常 200——停用只影响面板可见性，不影响渲染；
 *   · 只有「路径合式 + 库有此行 + ext 与库内一致 + 是内容寻址的新表情」才 200，其余一律 404。
 * 响应头对齐 /files：`default-src 'none'; sandbox` + 内容寻址的不可变缓存（next.config 已把 /emoji/**
 * 排除在全站头之外，给 public 静态旧枚与新路由下发同一套静态头，见 security-headers.ts）。
 */

const FILE_RE = /^(\d+)\.(gif|png|webp)$/;
/** int unsigned 的上限：超长数字串不必查库 */
const MAX_ID = 0xffffffff;

/** URL 扩展名 → Content-Type。表情格式是受控词汇（上传时嗅探、迁移期全部为 gif），不按任意扩展名推断 */
export const EMOJI_MIME: Readonly<Record<string, string>> = {
  gif: "image/gif",
  png: "image/png",
  webp: "image/webp",
};

/** 解析 URL 文件名：^(\d+)\.(gif|png|webp)$，不合式返回 null（调用方一律 404） */
export function parseEmojiFile(file: string): { id: number; ext: string } | null {
  const m = FILE_RE.exec(file);
  if (!m) return null;
  const id = Number(m[1]);
  if (!Number.isSafeInteger(id) || id < 1 || id > MAX_ID) return null;
  return { id, ext: m[2]! };
}

/** 构造响应头（纯函数，便于断言）。ETag 取内容 sha256——内容寻址天然不可变 */
export function emojiHeaders(sha256: string, ext: string, size: number): Record<string, string> {
  return {
    "content-type": EMOJI_MIME[ext] ?? "application/octet-stream",
    "content-length": String(size),
    "content-disposition": "inline",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    etag: `"${sha256}"`,
    "cache-control": "public, max-age=31536000, immutable",
  };
}

const notFound = () =>
  new Response("not found", { status: 404, headers: { "cache-control": "private, no-store" } });

/** storage_key（ab/cd/<sha>.<ext>）→ 内容 sha256；形态不合法返回 null */
export function shaOfStorageKey(storageKey: string): string | null {
  const key = parseFileKey(storageKey.split("/"));
  if (key === null) return null;
  const file = key.split("/")[2]!;
  return file.slice(0, file.lastIndexOf(".")) || null;
}

export async function handleEmojiRequest(
  req: Request,
  file: string,
  storageDir: string = getStorageDir(),
): Promise<Response> {
  const parsed = parseEmojiFile(file);
  if (!parsed) return notFound();
  const [row] = await getWebDb()
    .select({ ext: emojis.ext, storageKey: emojis.storageKey })
    .from(emojis)
    .where(eq(emojis.id, parsed.id))
    .limit(1);
  // 不存在 / ext 与库内不一致 / 静态资源（旧 50 枚由 public 提供，路由不兜底）→ 404
  if (!row || row.ext !== parsed.ext || row.storageKey === null) return notFound();
  const sha = shaOfStorageKey(row.storageKey);
  if (sha === null) return notFound();

  const etag = `"${sha}"`;
  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }

  const full = resolveStaticPath(storageDir, row.storageKey.split("/"));
  if (!full) return notFound();
  let size: number;
  try {
    const stat = await fs.stat(full);
    if (!stat.isFile()) return notFound();
    size = stat.size;
  } catch {
    console.error(`[emoji] 库有记录但存储缺失: ${row.storageKey}`);
    return notFound();
  }
  const body = Readable.toWeb(createReadStream(full)) as ReadableStream;
  return new Response(body, { status: 200, headers: emojiHeaders(sha, parsed.ext, size) });
}
