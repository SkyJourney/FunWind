import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/authz/require-admin";
import { addDecor } from "@/lib/brand/decor-pool-fs";
import { removeDecor } from "@/lib/brand/decor-pool";
import { addLogo } from "@/lib/brand/logo-pool-fs";
import { removeLogo } from "@/lib/brand/logo-pool";
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
  let packId: string | null = null;
  type AssetContext = { kind: "decor" | "logo"; file: string | null };
  const logFailure = (stage: string, asset: AssetContext | null, reason: unknown) => {
    console.error("[theme-pack-import] 主题包导入异常", {
      packId,
      actorId: actor.userId,
      stage,
      asset,
      reason,
    });
  };
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_THEME_PACK_ARCHIVE_BYTES + 64 * 1024) {
    return redirectTo("err=archive-too-large");
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch (error) {
    logFailure("parse-form", null, error);
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
  packId = id;
  const idError = validatePackId(id);
  if (idError) return redirectTo(`err=${idError}`);
  if (await getThemePack(id)) return redirectTo("err=duplicate-id");

  let pack: ReturnType<typeof parseThemePackArchive>;
  try {
    pack = parseThemePackArchive(new Uint8Array(await upload.arrayBuffer()));
  } catch (error) {
    logFailure("parse-archive", null, error);
    return redirectTo("err=bad-archive");
  }

  const actorConfig = { userId: actor.userId, via: "admin" as const, ip: actor.ip };
  const addedDecor: string[] = [];
  const addedLogo: string[] = [];
  const fileMap = new Map<string, string>();
  let created = false;
  let errorCode = "asset-import";
  let stage = "import-assets";
  let currentAsset: AssetContext | null = null;

  try {
    for (const asset of pack.assets) {
      stage = `import-${asset.kind}`;
      currentAsset = { kind: asset.kind, file: asset.poolFile };
      const displayName = `${pack.name} · ${asset.kind === "decor" ? "装饰" : "LOGO"}`;
      if (asset.kind === "decor") {
        const result = await addDecor(displayName, asset.bytes, actorConfig, {
          preserveActive: true,
        });
        if (!result.ok) throw new Error(result.code);
        fileMap.set(asset.poolFile, result.file);
        addedDecor.push(result.file);
      } else {
        const result = await addLogo(displayName, asset.bytes, actorConfig, {
          pack: id,
          preserveActive: true,
        });
        if (!result.ok) throw new Error(result.code);
        fileMap.set(asset.poolFile, result.file);
        addedLogo.push(result.file);
      }
    }

    stage = "create-pack";
    currentAsset = null;
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
      logFailure(stage, currentAsset, errorCode);
    } else {
      created = true;
    }
  } catch (error) {
    logFailure(stage, currentAsset, error);
    errorCode = "asset-import";
  }

  let cleanupFailed = false;
  // 导入入池不激活素材，因此无需恢复旧 active，避免覆盖期间发生的管理选择。
  // 补偿逐项隔离，某一素材清理失败也必须继续处理后续素材。
  const compensate = async (phase: string, asset: AssetContext, run: () => Promise<void>) => {
    try {
      await run();
    } catch (error) {
      cleanupFailed = true;
      logFailure(phase, asset, error);
    }
  };
  if (!created) {
    for (const file of addedDecor) {
      await compensate("remove-decor", { kind: "decor", file }, () =>
        removeDecor(file, actorConfig, { preserveActive: true }),
      );
    }
    for (const file of addedLogo) {
      await compensate("remove-logo", { kind: "logo", file }, () =>
        removeLogo(file, actorConfig, { preserveActive: true }),
      );
    }
  }

  const warning = cleanupFailed ? "&warn=import-cleanup" : "";
  if (!created) return redirectTo(`err=${errorCode}${warning}`);
  revalidatePath("/admin/themes");
  revalidatePath("/admin/decor");
  revalidatePath("/admin/logo");
  return redirectTo(`saved=imported&id=${encodeURIComponent(id)}${warning}`);
}
