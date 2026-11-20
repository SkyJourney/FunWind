import "@/modules";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import { listOpsTasks } from "@/lib/ops/tasks";

export const dynamic = "force-dynamic";

/** GET /api/manage/ops/tasks：运维任务与触发器列表（零表韧性返回空） */
export const GET = manageEndpoint(async () => manageOk({ items: await listOpsTasks() }), {
  endpoint: "ops",
});
