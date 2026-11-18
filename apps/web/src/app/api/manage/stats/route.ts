import { dashboardData } from "@/lib/admin/dashboard";
import { manageEndpoint, manageOk } from "@/lib/manage/route";

export const dynamic = "force-dynamic";

/** GET /api/manage/stats：看板统计（30 天注册/主题/回帖逐日、今日登录、总量；与后台看板同源，共享 60s 缓存） */
export const GET = manageEndpoint(async () => manageOk(await dashboardData()), {
  endpoint: "stats",
});
