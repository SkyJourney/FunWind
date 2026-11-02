import { getDecorPoolRaw, removeDecor } from "@/lib/brand/decor-pool";
import { getDecorUsage } from "@/lib/theme/packs";
import { addDecorFromUpload, json, requireThemeJson } from "@/lib/theme/admin-route";

// 主题工作区内嵌素材库的 JSON 上传/删除（M11.1 Step 7）：走 decor 池验真管线与引用保护，
// 删除被引用文件返回 409 + 引用清单（与 /admin/decor 管理页同一口径）。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return addDecorFromUpload(request);
}

export async function DELETE(request: Request): Promise<Response> {
  const auth = await requireThemeJson<{ file?: unknown }>(request);
  if ("response" in auth) return auth.response;
  const file = typeof auth.body.file === "string" ? auth.body.file : "";
  const pool = await getDecorPoolRaw();
  if (!pool.items.some((item) => item.file === file)) return json({ error: "not_found" }, 404);
  const usage = (await getDecorUsage()).get(file);
  if (usage?.length) {
    return json({ error: "in-use", usage }, 409);
  }
  await removeDecor(file, { userId: auth.actor.userId, via: "admin", ip: auth.actor.ip });
  return json({ ok: true });
}
