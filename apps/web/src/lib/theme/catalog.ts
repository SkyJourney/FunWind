import "server-only";

import { BUILTIN_THEME_COLORS, getWebDb, themePackages } from "@funwind/db";
import { DEFAULT_PACK, THEME_PACKS } from "@/lib/theme-packs";
import { parseThemePackDefinition, type ThemePackDefinition } from "./surface-schema";

/**
 * 主题包目录（M11.1 Step 3，docs/milestones/M11.1-theme-engine.md Step 3）：
 * 静态注册表（内置 CSS 包，随代码发布）∪ DB 数据包（/admin/themes 维护，enabled 才有效）。
 * 目录走 globalThis TTL 缓存（与 site-chrome 同款 30s 盒），管理保存后 invalidateThemeCatalog()。
 *
 * 校验口径（isKnownPackId）：静态包 ∪ DB 中 enabled 的包。停用/删除的包按未知处理——
 * 偏好读取侧（theme-pref）与站点默认（site-chrome.parseThemePack）据此安全回退 default。
 */

const TTL_MS = 30_000;

export interface CatalogPack {
  id: string;
  label: string;
  /** 来源：static=内置 CSS 包（themes/<id>.css 随代码发布）；db=/admin/themes 维护的数据包 */
  source: "static" | "db";
  enabled: boolean;
  /** 数据包自带 LOGO 池文件引用（静态包沿用 THEME_PACKS.logo） */
  logo: string | null;
  definition: ThemePackDefinition | null;
  themeColor: string;
  backgroundColor: string;
}

interface CatalogBox {
  at: number;
  packs: CatalogPack[];
}

const g = globalThis as unknown as { __fwThemeCatalog?: CatalogBox };

/** 目录读取器类型（可注入 fake，供纯单测覆盖缓存/回退分支） */
export type ThemeCatalogRow = {
  id: string;
  name: string;
  enabled: boolean;
  assets?: unknown;
  definition?: unknown;
};

export type ThemeCatalogReadDb = () => Promise<ThemeCatalogRow[]>;

function staticPacks(): CatalogPack[] {
  return THEME_PACKS.map((pack) => {
    const colors = BUILTIN_THEME_COLORS[pack.id] ?? BUILTIN_THEME_COLORS[DEFAULT_PACK];
    return {
      id: pack.id,
      label: pack.label,
      source: "static",
      enabled: true,
      logo: pack.logo,
      definition: null,
      themeColor: colors.themeColor,
      backgroundColor: colors.backgroundColor,
    };
  });
}

async function readDbPacksVia(readDb: ThemeCatalogReadDb): Promise<CatalogPack[]> {
  const rows = await readDb();
  const staticById = new Map(staticPacks().map((pack) => [pack.id, pack]));
  return rows
    .filter((row) => /^[a-z0-9][a-z0-9_-]{1,31}$/.test(row.id))
    .map((row) => {
      const staticPack = staticById.get(row.id);
      const parsed = row.definition === undefined ? null : parseThemePackDefinition(row.definition);
      const definition = parsed?.ok ? parsed.value : null;
      const assets = Array.isArray(row.assets)
        ? (row.assets as { poolFile?: unknown; kind?: unknown }[])
        : [];
      const logoAsset = assets.find(
        (asset) => asset.kind === "logo" && typeof asset.poolFile === "string",
      );
      const colors = definition?.pwa ?? {
        themeColor: staticPack?.themeColor ?? BUILTIN_THEME_COLORS[DEFAULT_PACK].themeColor,
        backgroundColor:
          staticPack?.backgroundColor ?? BUILTIN_THEME_COLORS[DEFAULT_PACK].backgroundColor,
      };
      return {
        id: row.id,
        label: row.name,
        source: staticPack ? "static" : "db",
        enabled: row.enabled,
        logo: logoAsset ? (logoAsset.poolFile as string) : (staticPack?.logo ?? null),
        definition,
        ...colors,
      };
    });
}

export interface ThemeCatalogDeps {
  readDb?: ThemeCatalogReadDb;
  now?: () => number;
}

/** 目录（TTL 缓存）：静态包 + DB 启用包；DB 读失败沿用上次目录、冷启动回静态包（不拖垮站点） */
export async function getThemeCatalog(deps: ThemeCatalogDeps = {}): Promise<CatalogPack[]> {
  const now = deps.now ?? Date.now;
  const box = g.__fwThemeCatalog;
  if (box && now() - box.at < TTL_MS) return box.packs;
  let packs = staticPacks();
  try {
    const staticEntries = staticPacks();
    const dbPacks = await readDbPacksVia(deps.readDb ?? defaultReadDb);
    const dbById = new Map(dbPacks.map((pack) => [pack.id, pack]));
    const staticPacksAvailable = staticEntries.flatMap((pack) => {
      const stored = dbById.get(pack.id);
      if (stored && !stored.enabled && pack.id !== DEFAULT_PACK) return [];
      return [stored ? { ...pack, ...stored, source: "static" as const } : pack];
    });
    const staticIds = new Set(staticPacksAvailable.map((pack) => pack.id));
    packs = [
      ...staticPacksAvailable,
      ...dbPacks.filter((pack) => pack.enabled && !staticIds.has(pack.id)),
    ];
  } catch (error) {
    if (box) return box.packs; // 库暂时不可用：沿用上次目录
    // 冷启动读库失败：回静态包（记日志供诊断，不打断站点）
    console.error("[theme-catalog] 读取数据包目录失败，暂用静态注册表:", error);
  }
  g.__fwThemeCatalog = { at: now(), packs };
  return packs;
}

/** 管理保存/启停/删除后失效（下一请求重建目录） */
export function invalidateThemeCatalog(): void {
  g.__fwThemeCatalog = undefined;
}

/** 测试与首帧路径：直接清缓存读目录 */
export async function refreshThemeCatalog(deps: ThemeCatalogDeps = {}): Promise<CatalogPack[]> {
  invalidateThemeCatalog();
  return getThemeCatalog(deps);
}

/** 目录校验：静态包 ∪ DB 启用包；停用/未知 id = 无效（偏好读取侧回退 default） */
export async function isKnownPackId(id: string, deps: ThemeCatalogDeps = {}): Promise<boolean> {
  const packs = await getThemeCatalog(deps);
  return packs.some((p) => p.id === id);
}

async function defaultReadDb(): Promise<ThemeCatalogRow[]> {
  // 必须 await 查询本身：直接 return query builder 时，测试 worker 上下文会把 builder
  // 当作已解析值透传（rows.filter 崩溃，M11.1 Step 3 实测）
  return await getWebDb()
    .select({
      id: themePackages.id,
      name: themePackages.name,
      enabled: themePackages.enabled,
      assets: themePackages.assets,
      definition: themePackages.definition,
    })
    .from(themePackages);
}

/** 生效包合成（目录校验版）：用户偏好 → 站点默认 → default；任一级无效即落到下一级 */
export async function resolveEffectivePackValidated(
  isKnown: (id: string) => Promise<boolean>,
  input: { userPref?: string | null; siteDefault?: string | null },
): Promise<string> {
  if (input.userPref && (await isKnown(input.userPref))) return input.userPref;
  if (input.siteDefault && (await isKnown(input.siteDefault))) return input.siteDefault;
  return DEFAULT_PACK;
}
