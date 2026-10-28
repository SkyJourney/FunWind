import { getCurrentUser } from "@/lib/auth/session";
import { conversationPage } from "@/lib/pm/queries";
import { parseStreamPage } from "@/lib/stream/page";
import { streamJson, streamRateLimit, streamUnauthorized } from "@/lib/stream/respond";

/**
 * 私信会话列表的追加取数（M10.7 Step 3b）。GET `?page=`，口径与 /messages 一致。
 * 会话属于登录用户个人：游客 401；只返回自己所在的会话（userId 取自会话，不接受参数指定）。
 * conversationPage 取 perPage+1 条判断 hasMore，越界页天然为空页。
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const limited = streamRateLimit(request);
  if (limited) return limited;

  const user = await getCurrentUser();
  if (!user) return streamUnauthorized();

  const page = parseStreamPage(new URL(request.url).searchParams.get("page"));
  const result = await conversationPage(user.id, page);
  return streamJson({
    items: result.items.map((c) => ({ ...c, id: c.conversationId })),
    hasMore: result.hasMore,
    page: result.page,
  });
}
