import { getCurrentSubject } from "@/lib/authz/subject";
import { tagByName } from "@/lib/interact/tags";
import { getForumView } from "@/lib/queries/forums";
import { listThreads } from "@/lib/queries/threads";
import { parsePositiveInt, parseStreamPage } from "@/lib/stream/page";
import { streamJson, streamNotFound, streamRateLimit } from "@/lib/stream/respond";

/**
 * 板块页主题列表的追加取数（M10.7，BUG12）。GET `?type=&tag=&page=`，参数口径与板块页一致。
 * 权限与板块页同一套：getForumView 读不到 / 是分区 / 不存在 → 一律 404。
 * 追加页只含普通主题：置顶块只在首屏（第 1 页）由服务端渲染，不属于流。
 * listThreads 会把越界页码收束到末页，这里先比较页码，越界返回空页，避免重复追加末页。
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ fid: string }> };

export async function GET(request: Request, { params }: Ctx): Promise<Response> {
  const limited = streamRateLimit(request);
  if (limited) return limited;

  const fid = parsePositiveInt((await params).fid);
  if (fid === undefined) return streamNotFound();

  const query = new URL(request.url).searchParams;
  const page = parseStreamPage(query.get("page"));
  const prefixId = parsePositiveInt(query.get("type")) ?? 0;
  const tagRaw = query.get("tag");
  const tag = tagRaw ? await tagByName(tagRaw) : null;

  const viewer = await getCurrentSubject();
  const forum = await getForumView(viewer, fid);
  if (!forum || forum.kind === "section") return streamNotFound();

  const list = await listThreads(viewer, fid, { page, prefixId, tagId: tag?.id });
  if (page > list.totalPages) return streamJson({ items: [], hasMore: false, page });
  return streamJson({ items: list.items, hasMore: list.page < list.totalPages, page: list.page });
}
