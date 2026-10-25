import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { listFeed, unreadSummary } from "@/lib/notifications/queries";
// 通知模块的读取不依赖注册表求值（未读数/时间线是纯查询）；消费侧已由 defineAction/页面宿主求值

export const dynamic = "force-dynamic";

/**
 * 铃铛数据（M8）：GET /api/notifications/bell
 * 返回总未读数、各分类未读数与最近 10 条聚合后的未读。面板打开/窗口聚焦时拉取。
 */
export async function GET() {
  const user = await getCurrentUser();
  const [summary, recent] = await Promise.all([
    unreadSummary(user?.id ?? null),
    listFeed(user?.id ?? null, { limit: 10 }),
  ]);
  return NextResponse.json({
    unread: summary,
    // 面板只展示未读（已读历史在 /notifications 页）
    recent: recent.items
      .filter((i) => !i.read)
      .map((i) => ({
        kind: i.kind,
        id: i.id,
        category: i.category,
        type: i.type,
        actorName: i.actorName,
        createdAt: i.createdAt,
        data: i.data,
        title: i.title,
      })),
  });
}
