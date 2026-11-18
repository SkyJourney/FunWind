import { loadWhoami } from "@/lib/manage/whoami";
import { manageEndpoint, manageOk } from "@/lib/manage/route";

export const dynamic = "force-dynamic";

/** GET /api/manage/whoami：token 元信息 + 持有人 + 有效权限点全清单（握手；不写审计） */
export const GET = manageEndpoint(
  async ({ request, token, subject }) =>
    manageOk(
      await loadWhoami(
        token,
        subject,
        request.nextUrl.searchParams.get("include") === "token_permissions",
      ),
    ),
  { endpoint: "whoami" },
);
