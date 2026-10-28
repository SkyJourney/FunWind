import { getCurrentSubject } from "@/lib/authz/subject";
import { getProfile, getUserReplies, getUserThreads } from "@/lib/queries/users";
import { parsePositiveInt, parseStreamPage } from "@/lib/stream/page";
import { streamJson, streamNotFound, streamRateLimit } from "@/lib/stream/respond";

/**
 * 用户主页内容的追加取数（M10.7 Step 3b）。GET `?tab=threads|replies&page=`，口径与个人公开页一致。
 * - 用户不存在或已注销（含「已注销用户」占位账号）→ 404，与个人页同口径；
 * - 内容可见性完全由 getUserThreads / getUserReplies 决定（观众可读 + 上目录 + visible），本端点不放宽；
 * - 页码越界返回空页：两个查询会把越界页码收束到末页，直接返回会重复追加末页。
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ uid: string }> };

export async function GET(request: Request, { params }: Ctx): Promise<Response> {
  const limited = streamRateLimit(request);
  if (limited) return limited;

  const uid = parsePositiveInt((await params).uid);
  if (uid === undefined) return streamNotFound();
  if (!(await getProfile(uid))) return streamNotFound();

  const query = new URL(request.url).searchParams;
  const page = parseStreamPage(query.get("page"));
  const viewer = await getCurrentSubject();

  if (query.get("tab") === "replies") {
    const replies = await getUserReplies(viewer, uid, page);
    if (page > replies.totalPages) return streamJson({ items: [], hasMore: false, page });
    return streamJson({
      items: replies.items.map((r) => ({ ...r, id: r.postId })),
      hasMore: replies.page < replies.totalPages,
      page: replies.page,
    });
  }

  const threads = await getUserThreads(viewer, uid, page);
  if (page > threads.totalPages) return streamJson({ items: [], hasMore: false, page });
  return streamJson({
    items: threads.items,
    hasMore: threads.page < threads.totalPages,
    page: threads.page,
  });
}
