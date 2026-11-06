import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/authz/require-admin";
import { readDecorBytes } from "@/lib/brand/decor-pool-fs";
import { readLogoBytes } from "@/lib/brand/logo-pool-fs";
import { bundledLogoOf } from "@/lib/theme-packs";
import { getThemePack, parseThemePackAssets } from "@/lib/theme/packs";
import {
  buildThemePackArchive,
  type ThemePackArchiveAssetInput,
} from "@/lib/theme/theme-pack-archive";
import { parseThemePackDefinition } from "@/lib/theme/surface-schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  await requireAdmin("site.admin");
  const { id } = await context.params;
  const pack = await getThemePack(id);
  if (!pack) notFound();
  const definition = parseThemePackDefinition(pack.definition);
  if (!definition.ok) {
    return new Response("主题配置无法通过安全校验，暂不能导出。", { status: 409 });
  }

  const assets = parseThemePackAssets(pack.assets);
  const archiveAssets: ThemePackArchiveAssetInput[] = [];
  for (const asset of assets) {
    const bytes =
      asset.kind === "decor"
        ? await readDecorBytes(asset.poolFile)
        : await readLogoBytes(asset.poolFile);
    if (!bytes) {
      return new Response(`素材池中缺少文件：${asset.poolFile}`, { status: 409 });
    }
    archiveAssets.push({ kind: asset.kind, poolFile: asset.poolFile, bytes });
  }
  const staticLogo = bundledLogoOf(pack.id);
  if (staticLogo && !assets.some((asset) => asset.kind === "logo")) {
    let bytes: Buffer;
    try {
      bytes = await readFile(path.join(process.cwd(), "public", "logo", path.basename(staticLogo)));
    } catch {
      return new Response(`内置主题缺少 LOGO 文件：${path.basename(staticLogo)}`, { status: 409 });
    }
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
    archiveAssets.push({ kind: "logo", poolFile: `logo-${hash}.png`, bytes });
  }

  let archive: Uint8Array;
  try {
    archive = buildThemePackArchive({
      id: pack.id,
      name: pack.name,
      description: pack.description,
      schemaVersion: pack.schemaVersion,
      definition: definition.value,
      assets: archiveAssets,
    });
  } catch {
    return new Response("主题包资源清单不完整，暂不能导出。", { status: 409 });
  }

  return new Response(Buffer.from(archive), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${pack.id}.funwind-theme.zip"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
