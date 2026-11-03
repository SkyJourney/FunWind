import { getLogoPoolRaw, removeLogo } from "@/lib/brand/logo-pool";
import { addLogo } from "@/lib/brand/logo-pool-fs";
import { getThemePack, setThemePackLogo } from "@/lib/theme/packs";
import { actorOf, json, requireThemeJson, requireThemeUpload } from "@/lib/theme/admin-route";

// 主题工作区的「主题自带 LOGO」JSON 路由（M11.1 Step 7）：POST 上传并绑定（带 pack 标签）、
// PATCH 从池内换绑、DELETE 解绑；与 setSiteDefaultThemePack 的联动同一数据源（assets kind=logo）。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request): Promise<Response> {
  const upload = await requireThemeUpload(request);
  if ("response" in upload) return upload.response;
  const packId = String(upload.form.get("packId") ?? "");
  if (!packId || !(await getThemePack(packId))) return json({ error: "not_found" }, 404);

  const added = await addLogo(upload.displayName, upload.bytes, actorOf(upload.actor), {
    pack: packId,
  });
  if (!added.ok) return json({ error: added.code }, 422);
  const file = added.pool.active!;
  const bound = await setThemePackLogo(packId, file, actorOf(upload.actor));
  if (!bound.ok) return json({ error: bound.code }, 422);
  return json({ ok: true, file });
}

export async function PATCH(request: Request): Promise<Response> {
  const auth = await requireThemeJson<{ packId?: unknown; file?: unknown }>(request);
  if ("response" in auth) return auth.response;
  const packId = typeof auth.body.packId === "string" ? auth.body.packId : "";
  const file = typeof auth.body.file === "string" ? auth.body.file : "";
  if (!packId || !file) return json({ error: "bad_request" }, 400);
  const result = await setThemePackLogo(packId, file, actorOf(auth.actor));
  if (!result.ok) return json({ error: result.code }, result.code === "not-found" ? 404 : 422);
  return json({ ok: true, file });
}

export async function DELETE(request: Request): Promise<Response> {
  const auth = await requireThemeJson<{ packId?: unknown; removeFromPool?: unknown }>(request);
  if ("response" in auth) return auth.response;
  const packId = typeof auth.body.packId === "string" ? auth.body.packId : "";
  if (!packId) return json({ error: "bad_request" }, 400);
  const pack = await getThemePack(packId);
  const current = parseLogoAsset(pack);
  if (!current) return json({ ok: true, file: null });

  const result = await setThemePackLogo(packId, null, actorOf(auth.actor));
  if (!result.ok) return json({ error: result.code }, 422);
  // removeFromPool=true 时连池内文件一起移出（仍受 LOGO 管理页/当前项语义约束）
  if (auth.body.removeFromPool === true) {
    const pool = await getLogoPoolRaw();
    const item = pool.items.find((candidate) => candidate.file === current);
    if (item && pool.active !== current) {
      await removeLogo(current, actorOf(auth.actor));
    }
  }
  return json({ ok: true, file: null });
}

function parseLogoAsset(pack: Awaited<ReturnType<typeof getThemePack>>): string | null {
  if (!pack) return null;
  const assets = Array.isArray(pack.assets) ? pack.assets : [];
  for (const asset of assets) {
    if (
      asset &&
      typeof asset === "object" &&
      (asset as { kind?: unknown }).kind === "logo" &&
      typeof (asset as { poolFile?: unknown }).poolFile === "string"
    ) {
      return (asset as { poolFile: string }).poolFile;
    }
  }
  return null;
}
