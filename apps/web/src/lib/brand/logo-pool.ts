import { eq, sql } from "drizzle-orm";
import { getWebDb, siteSettings } from "@funwind/db";
import { CLI_ACTOR, writeAudit, type ConfigActor } from "@/lib/audit";
import { invalidateSiteChrome } from "@/lib/site-chrome";

/**
 * LOGO 池（M10.5，docs/LOGO-POOL.md）：品牌素材不入附件授权管线——
 * 品牌位全端公开（含游客/每页必出），独立写 STORAGE_DIR/site/ 并经 /brand/logo 公开路由输出；
 * 池元数据（清单+当前项）存 site_settings("site.logo")，切换走 site-chrome 的 TTL 缓存失效。
 * 写路径仅 LOGO 管理页（site.admin 门禁）与主题↔LOGO 联动（M11，docs/THEME-SYSTEM.md §5）。
 */

export interface LogoItem {
  /** 文件名（STORAGE_DIR/site/ 下，形如 logo-<ts>.png） */
  file: string;
  name: string;
  /** 主题包自带 LOGO 的来源标签（lib/theme-packs 的 id）；联动按它去重、管理页显示「〈主题〉自带」徽标 */
  pack?: string;
}

export interface LogoPool {
  items: LogoItem[];
  active: string | null;
}

const KEY = "site.logo";
const SAFE_NAME = /^logo-[a-z0-9]+\.png$/;
const SAFE_PACK = /^[a-z0-9][a-z0-9-]{0,31}$/;
export function parseLogoPool(raw: unknown): LogoPool {
  const o = raw as { items?: unknown; active?: unknown } | null;
  const items = Array.isArray(o?.items)
    ? o.items.flatMap((x) => {
        const it = x as Partial<LogoItem>;
        if (typeof it?.file !== "string" || !SAFE_NAME.test(it.file) || typeof it.name !== "string")
          return [];
        const item: LogoItem = { file: it.file, name: it.name.slice(0, 40) };
        if (typeof it.pack === "string" && SAFE_PACK.test(it.pack)) item.pack = it.pack;
        return [item];
      })
    : [];
  const active = typeof o?.active === "string" ? o.active : null;
  return { items, active: items.some((i) => i.file === active) ? active : null };
}

export async function getLogoPoolRaw(): Promise<LogoPool> {
  const [row] = await getWebDb()
    .select({ value: siteSettings.value })
    .from(siteSettings)
    .where(eq(siteSettings.key, KEY))
    .limit(1);
  return parseLogoPool(row?.value);
}

const sqlNow = () => sql`NOW()`;

async function updatePool(
  change: (pool: LogoPool) => LogoPool,
  actor: ConfigActor,
  action: string,
  targetId: string,
): Promise<LogoPool> {
  const next = await getWebDb().transaction(async (tx) => {
    await tx
      .insert(siteSettings)
      .values({ key: KEY, value: { items: [], active: null }, updatedAt: sqlNow() })
      .onDuplicateKeyUpdate({ set: { key: KEY } });
    const [row] = await tx
      .select({ value: siteSettings.value })
      .from(siteSettings)
      .where(eq(siteSettings.key, KEY))
      .for("update");
    const before = parseLogoPool(row?.value);
    const after = change(before);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      await tx
        .update(siteSettings)
        .set({ value: after, updatedAt: sqlNow() })
        .where(eq(siteSettings.key, KEY));
      await writeAudit(tx, {
        actorId: actor.userId,
        action,
        targetType: "logo",
        targetId,
        before,
        // via 区分来源：admin=管理页手动 / theme=设默认主题联动 / cli=脚本
        after: { ...after, via: actor.via },
        ip: actor.ip,
      });
    }
    return after;
  });
  invalidateSiteChrome();
  return next;
}

export async function setActiveLogo(file: string, actor: ConfigActor = CLI_ACTOR): Promise<void> {
  await updatePool(
    (pool) => (pool.items.some((i) => i.file === file) ? { ...pool, active: file } : pool),
    actor,
    "admin.logo.activate",
    file,
  );
}

/** 停用并移出池（文件保留在磁盘，误删可手工找回）；当前项被移除则回到 Wind 占位。 */
export async function removeLogo(file: string, actor: ConfigActor = CLI_ACTOR): Promise<void> {
  await updatePool(
    (pool) => ({
      items: pool.items.filter((i) => i.file !== file),
      active: pool.active === file ? null : pool.active,
    }),
    actor,
    "admin.logo.remove",
    file,
  );
}

/** 入池登记（DB 半）：由 fs 侧 addLogo 在写盘成功后调用；pack = 主题包自带 LOGO 的来源标签。 */
export async function registerLogo(
  name: string,
  file: string,
  actor: ConfigActor = CLI_ACTOR,
  pack?: string,
): Promise<LogoPool> {
  return updatePool(
    (pool) => ({
      items: [...pool.items, pack ? { file, name, pack } : { file, name }],
      active: file,
    }),
    actor,
    "admin.logo.upload",
    file,
  );
}
