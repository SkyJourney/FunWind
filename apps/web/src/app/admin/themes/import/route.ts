import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/authz/require-admin";
import { addDecor } from "@/lib/brand/decor-pool-fs";
import { getDecorPoolRaw, removeDecor, setActiveDecor } from "@/lib/brand/decor-pool";
import { addLogo } from "@/lib/brand/logo-pool-fs";
import { getLogoPoolRaw, removeLogo, setActiveLogo } from "@/lib/brand/logo-pool";
import { isSameOrigin } from "@/lib/net/same-origin";
import { createThemePack, getThemePack, validatePackId } from "@/lib/theme/packs";
import {
  MAX_THEME_PACK_ARCHIVE_BYTES,
  parseThemePackArchive,
} from "@/lib/theme/theme-pack-archive";
import type { SurfaceCapabilities, ThemePackDefinition } from "@/lib/theme/surface-schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function redirectTo(query: string): Response {
  return new Response(null, { status: 303, headers: { location: `/admin/themes?${query}` } });
}

function remapDefinition(
  definition: ThemePackDefinition,
  fileMap: ReadonlyMap<string, string>,
): ThemePackDefinition {
  const remapCapabilities = (caps: SurfaceCapabilities): SurfaceCapabilities => {
    const remapped = { ...caps };
    if (caps.fill?.type === "image") {
      remapped.fill = {
        ...caps.fill,
        asset: fileMap.get(caps.fill.asset) ?? caps.fill.asset,
      };
    }
    if (caps.overlay?.type === "image") {
      remapped.overlay = {
        ...caps.overlay,
        asset: fileMap.get(caps.overlay.asset) ?? caps.overlay.asset,
      };
    }
    if (caps.contentSlot?.image) {
      remapped.contentSlot = {
        ...caps.contentSlot,
        image: fileMap.get(caps.contentSlot.image) ?? caps.contentSlot.image,
      };
    }
    return remapped;
  };
  return {
    // PWA 元数据不含资源引用，原样保留（此前丢失会导致导入包的 manifest 色回退默认）
    ...(definition.pwa ? { pwa: definition.pwa } : {}),
    surfaces: Object.fromEntries(
      Object.entries(definition.surfaces).map(([id, entry]) => [
        id,
        {
          light: remapCapabilities(entry.light),
          ...(entry.dark ? { dark: remapCapabilities(entry.dark) } : {}),
        },
      ]),
    ),
  };
}

export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return new Response("Forbidden", { status: 403 });
  const actor = await requireAdmin("site.admin");
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_THEME_PACK_ARCHIVE_BYTES + 64 * 1024) {
    return redirectTo("err=archive-too-large");
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return redirectTo("err=bad-archive");
  }
  const upload = form.get("archive");
  const idInput = form.get("id");
  if (!(upload instanceof File) || typeof idInput !== "string") {
    return redirectTo("err=bad-archive");
  }
  if (upload.size === 0 || upload.size > MAX_THEME_PACK_ARCHIVE_BYTES) {
    return redirectTo("err=archive-too-large");
  }

  const id = idInput.trim().toLowerCase();
  const idError = validatePackId(id);
  if (idError) return redirectTo(`err=${idError}`);
  if (await getThemePack(id)) return redirectTo("err=duplicate-id");

  let pack: ReturnType<typeof parseThemePackArchive>;
  try {
    pack = parseThemePackArchive(new Uint8Array(await upload.arrayBuffer()));
  } catch {
    return redirectTo("err=bad-archive");
  }

  const actorConfig = { userId: actor.userId, via: "admin" as const, ip: actor.ip };
  const decorBefore = await getDecorPoolRaw();
  const logoBefore = await getLogoPoolRaw();
  const addedDecor: string[] = [];
  const addedLogo: string[] = [];
  const fileMap = new Map<string, string>();
  let created = false;
  let errorCode = "asset-import";

  try {
    for (const asset of pack.assets) {
      const displayName = `${pack.name} · ${asset.kind === "decor" ? "装饰" : "LOGO"}`;
      if (asset.kind === "decor") {
        const result = await addDecor(displayName, asset.bytes, actorConfig);
        if (!result.ok || !result.pool.active) throw new Error("decor-import-failed");
        fileMap.set(asset.poolFile, result.pool.active);
        addedDecor.push(result.pool.active);
      } else {
        const result = await addLogo(displayName, asset.bytes, actorConfig, { pack: id });
        if (!result.ok || !result.pool.active) throw new Error("logo-import-failed");
        fileMap.set(asset.poolFile, result.pool.active);
        addedLogo.push(result.pool.active);
      }
    }

    const definition = remapDefinition(pack.definition, fileMap);
    const assets = pack.assets.map((asset) => ({
      kind: asset.kind,
      poolFile: fileMap.get(asset.poolFile) ?? asset.poolFile,
      sha256: asset.sha256,
      bytes: asset.bytes.byteLength,
    }));
    const result = await createThemePack({
      id,
      name: pack.name,
      description: pack.description,
      definition,
      assets,
      actor: actorConfig,
    });
    if (!result.ok) {
      errorCode = result.code ?? "asset-import";
    } else {
      created = true;
    }
  } catch {
    errorCode = "asset-import";
  }

  if (!created) {
    for (const file of addedDecor) await removeDecor(file, actorConfig).catch(() => {});
    for (const file of addedLogo) await removeLogo(file, actorConfig).catch(() => {});
  }
  const restorePools: Promise<void>[] = [];
  if (addedDecor.length > 0) restorePools.push(setActiveDecor(decorBefore.active, actorConfig));
  if (addedLogo.length > 0) restorePools.push(setActiveLogo(logoBefore.active, actorConfig));
  await Promise.allSettled(restorePools);

  if (!created) return redirectTo(`err=${errorCode}`);
  revalidatePath("/admin/themes");
  revalidatePath("/admin/decor");
  revalidatePath("/admin/logo");
  return redirectTo(`saved=imported&id=${encodeURIComponent(id)}`);
}
