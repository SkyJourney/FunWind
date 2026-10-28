import { getCurrentUser } from "@/lib/auth/session";
import { listFeed, type FeedCategory } from "@/lib/notifications/queries";
import { toNotificationRow } from "@/lib/notifications/row";
import { streamJson, streamRateLimit, streamUnauthorized } from "@/lib/stream/respond";

/**
 * 通知时间线的追加取数（M10.7 Step 3b）。GET `?cat=&before=`，口径与 /notifications 一致。
 * 通知属于登录用户个人：游客 401；只读取自己的通知（userId 取自会话）。
 * 与其它端点不同，这里是**游标分页**：`before` 是上一页最后一项的 createdAt，响应带 `nextCursor`。
 * 行数据由 toNotificationRow 在服务端预渲染（与页面首屏同一函数）：文案模板与原始载荷不下发。
 */
export const dynamic = "force-dynamic";

const CATEGORIES: readonly FeedCategory[] = [
  "interaction",
  "message",
  "moderation",
  "account",
  "announcement",
];

export async function GET(request: Request): Promise<Response> {
  const limited = streamRateLimit(request);
  if (limited) return limited;

  const user = await getCurrentUser();
  if (!user) return streamUnauthorized();

  const query = new URL(request.url).searchParams;
  const catRaw = query.get("cat");
  const category = CATEGORIES.find((c) => c === catRaw);
  const before = query.get("before") || undefined;

  const feed = await listFeed(user.id, { category, before });
  return streamJson({
    items: feed.items.map(toNotificationRow),
    hasMore: feed.nextCursor !== null,
    page: 0,
    nextCursor: feed.nextCursor,
  });
}
