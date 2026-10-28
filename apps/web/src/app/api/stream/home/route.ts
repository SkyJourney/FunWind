import { getForumTree } from "@/lib/authz/snapshot";
import { getCurrentSubject } from "@/lib/authz/subject";
import { getHomeFeed } from "@/lib/queries/threads";
import { parsePositiveInt, parseStreamPage } from "@/lib/stream/page";
import { streamJson, streamRateLimit } from "@/lib/stream/respond";
import type { HomeStreamItem } from "@/lib/stream/types";

/**
 * 首页内容流的追加取数（M10.7，BUG3）。GET `?sec=&sort=&page=`，参数口径与首页一致。
 * 复用 getHomeFeed：可见性在取数前翻译成 SQL 谓词，游客读不到的版块不会出现；页码超出末页时返回空页。
 * 板块名取自版块树：条目本身已经过可见性过滤，其所属版块必然是读得到的，名称不构成泄露。
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const limited = streamRateLimit(request);
  if (limited) return limited;

  const params = new URL(request.url).searchParams;
  const page = parseStreamPage(params.get("page"));
  const sort = params.get("sort") === "new" ? ("new" as const) : ("last" as const);
  const sectionId = parsePositiveInt(params.get("sec"));

  const viewer = await getCurrentSubject();
  const [feed, tree] = await Promise.all([
    getHomeFeed(viewer, { sectionId, sort, page }),
    getForumTree(),
  ]);

  const items: HomeStreamItem[] = feed.items.map((item) => ({
    ...item,
    forumName: tree.get(item.forumId)?.name ?? null,
  }));
  return streamJson({ items, hasMore: feed.hasMore, page: feed.page });
}
