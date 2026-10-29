import { createHash } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { emojiGroups, emojis, getWebDb } from "@funwind/db";

/**
 * 社区表情目录（M10.9，设计稿 §2.6）：公开只读、与登录无关；enabled=true 的表情（组停用整体隐藏——
 * 面板只展示可插入的内容；已发布正文的渲染不受影响，提供路由不读这里）。一次全量返回（数量级几百）。
 * 短缓存 + ETag：面板数据变化频率低（后台改名后才变），60s 内走共享缓存，跨秒级的重访靠 ETag 304。
 * 零数据站点返回 []（面板只显示 Unicode 页签）。
 * groupIcon = 分组标题图（emoji_groups.icon_key → /files/<key> 公开出口；NULL = 无）。
 */

const CACHE_MAX_AGE = 60;

export async function GET(req: Request): Promise<Response> {
  const rows = await getWebDb()
    .select({
      id: emojis.id,
      name: emojis.name,
      keywords: emojis.keywords,
      ext: emojis.ext,
      width: emojis.width,
      height: emojis.height,
      group: emojiGroups.name,
      groupEnabled: emojiGroups.enabled,
      groupIcon: emojiGroups.iconKey,
    })
    .from(emojis)
    .innerJoin(emojiGroups, eq(emojis.groupId, emojiGroups.id))
    .where(eq(emojis.enabled, true))
    .orderBy(asc(emojiGroups.sort), asc(emojiGroups.id), asc(emojis.sort), asc(emojis.id));

  // 表情或所属组停用 → 从面板隐藏（已发布正文的渲染不受影响，提供路由不读这里）
  const body = JSON.stringify(
    rows
      .filter((r) => r.groupEnabled)
      .map((r) => ({
        id: r.id,
        name: r.name,
        keywords: r.keywords,
        url: `/emoji/${r.id}.${r.ext}`,
        group: r.group,
        groupIcon: r.groupIcon === null ? null : `/files/${r.groupIcon}`,
        width: r.width,
        height: r.height,
      })),
  );

  const etag = `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;
  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, {
      status: 304,
      headers: {
        etag,
        "cache-control": `public, max-age=${CACHE_MAX_AGE}`,
      },
    });
  }
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${CACHE_MAX_AGE}`,
      etag,
    },
  });
}
