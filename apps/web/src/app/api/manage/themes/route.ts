import "@/modules";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import { listThemePacks } from "@/lib/theme/packs";

export const dynamic = "force-dynamic";

/** GET /api/manage/themes：主题包列表（含停用全量，含 revision） */
export const GET = manageEndpoint(async () => manageOk({ items: await listThemePacks() }), {
  endpoint: "themes",
});
