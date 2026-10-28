import { getCurrentUser } from "@/lib/auth/session";
import { getForumTree } from "@/lib/authz/snapshot";
import { getCurrentSubject } from "@/lib/authz/subject";
import { getFollowFeed, type FollowFeedType } from "@/lib/queries/follows-feed";
import { parseStreamPage } from "@/lib/stream/page";
import { streamJson, streamRateLimit, streamUnauthorized } from "@/lib/stream/respond";
import type { HomeStreamItem } from "@/lib/stream/types";

/**
 * 关注动态的追加取数（M10.7 Step 3b）。GET `?type=all|forum|user&page=`，口径与 /follows 一致。
 * 内容属于登录用户个人：游客一律 401；可见性由 getFollowFeed 决定（可读 + 上目录 + visible）。
 * 页码越界返回空页（getFollowFeed 会把越界页码收束到末页，直接返回会重复追加末页）。
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const limited = streamRateLimit(request);
  if (limited) return limited;

  const user = await getCurrentUser();
  if (!user) return streamUnauthorized();

  const query = new URL(request.url).searchParams;
  const page = parseStreamPage(query.get("page"));
  const raw = query.get("type");
  const type: FollowFeedType = raw === "forum" || raw === "user" ? raw : "all";

  const [feed, tree] = await Promise.all([
    getFollowFeed(await getCurrentSubject(), page, type),
    getForumTree(),
  ]);
  if (page > feed.totalPages) return streamJson({ items: [], hasMore: false, page });

  // 条目已过可见性过滤，其所属版块必然读得到，名称不构成泄露
  const items: HomeStreamItem[] = feed.items.map((item) => ({
    ...item,
    forumName: tree.get(item.forumId)?.name ?? null,
  }));
  return streamJson({ items, hasMore: feed.page < feed.totalPages, page: feed.page });
}
