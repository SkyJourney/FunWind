import { getCurrentUser } from "@/lib/auth/session";
import { getLedgerPage } from "@/lib/points/ledger";
import { parseStreamPage } from "@/lib/stream/page";
import { streamJson, streamRateLimit, streamUnauthorized } from "@/lib/stream/respond";

/**
 * 积分流水的追加取数（M10.7 Step 3b）。GET `?page=`，口径与 /points 一致。
 * 流水属于登录用户个人：游客 401；只读取自己的台账（userId 取自会话，不接受任何参数指定）。
 * 页码越界返回空页（getLedgerPage 会把越界页码收束到末页，直接返回会重复追加末页）。
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const limited = streamRateLimit(request);
  if (limited) return limited;

  const user = await getCurrentUser();
  if (!user) return streamUnauthorized();

  const page = parseStreamPage(new URL(request.url).searchParams.get("page"));
  const ledger = await getLedgerPage(user.id, page);
  if (page > ledger.totalPages) return streamJson({ items: [], hasMore: false, page });
  return streamJson({
    items: ledger.items,
    hasMore: ledger.page < ledger.totalPages,
    page: ledger.page,
  });
}
