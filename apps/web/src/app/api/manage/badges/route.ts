import "@/modules";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import { badgeDictionary } from "@/lib/badges/service";

export const dynamic = "force-dynamic";

/** GET /api/manage/badges：徽章字典（可授予荣誉口径，与后台授予页一致） */
export const GET = manageEndpoint(async () => manageOk({ items: await badgeDictionary() }), {
  endpoint: "badges",
});
