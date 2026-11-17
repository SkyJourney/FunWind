import { loadWhoami } from "@/lib/manage/whoami";
import { manageEndpoint, manageOk } from "@/lib/manage/route";

export const dynamic = "force-dynamic";

/** GET /api/manage/whoami：token 元信息 + 持有人 + 有效权限点全清单（握手；不写审计） */
export const GET = manageEndpoint(
  async ({ token, subject }) => manageOk(await loadWhoami(token, subject)),
  { endpoint: "whoami", audit: false },
);
