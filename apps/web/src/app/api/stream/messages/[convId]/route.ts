import { getCurrentUser } from "@/lib/auth/session";
import { isConversationMember, messagesBefore } from "@/lib/pm/queries";
import { parsePositiveInt } from "@/lib/stream/page";
import {
  streamJson,
  streamNotFound,
  streamRateLimit,
  streamUnauthorized,
} from "@/lib/stream/respond";

/**
 * 聊天历史的上滑加载（M10.7 Step 3c）。GET `?before=<消息 id>`：取 id 更小的一批，按旧→新排列。
 * - 游客 401；非会话成员 404（与聊天页同口径，不暴露会话是否存在）；
 * - 只读校验成员资格，**不推进已读指针**（已读只在打开聊天页时推进）；
 * - 游标分页：响应的 `nextCursor` 是本批最旧一条的 id，下一次请求把它作为 `before`；
 *   `page` 无意义（固定 0）。
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ convId: string }> };

export async function GET(request: Request, { params }: Ctx): Promise<Response> {
  const limited = streamRateLimit(request);
  if (limited) return limited;

  const user = await getCurrentUser();
  if (!user) return streamUnauthorized();

  const convId = parsePositiveInt((await params).convId);
  if (convId === undefined || !(await isConversationMember(user.id, convId))) {
    return streamNotFound();
  }

  const before = parsePositiveInt(new URL(request.url).searchParams.get("before")) ?? null;
  const batch = await messagesBefore(convId, before);
  const oldest = batch.items[0];
  return streamJson({
    items: batch.items,
    hasMore: batch.hasMore,
    page: 0,
    nextCursor: batch.hasMore && oldest ? String(oldest.id) : null,
  });
}
