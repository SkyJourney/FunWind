import { eq, sql } from "drizzle-orm";
import { getWebDb, siteSettings } from "@funwind/db";
import { invalidateSiteChrome } from "@/lib/site-chrome";

/**
 * LOGO 池（M10.5，docs/LOGO-POOL.md）：品牌素材不入附件授权管线——
 * 品牌位全端公开（含游客/每页必出），独立写 STORAGE_DIR/site/ 并经 /brand/logo 公开路由输出；
 * 池元数据（清单+当前项）存 site_settings("site.logo")，切换走 site-chrome 的 TTL 缓存失效。
 * 写路径仅 LOGO 管理页（site.admin 门禁）。
 */

export interface LogoItem {
  /** 文件名（STORAGE_DIR/site/ 下，形如 logo-<ts>.png） */
  file: string;
  name: string;
}

export interface LogoPool {
  items: LogoItem[];
  active: string | null;
}

const KEY = "site.logo";
const SAFE_NAME = /^logo-[a-z0-9]+\.png$/;
export function parseLogoPool(raw: unknown): LogoPool {
  const o = raw as { items?: unknown; active?: unknown } | null;
  const items = Array.isArray(o?.items)
    ? o.items.flatMap((x) => {
        const it = x as Partial<LogoItem>;
        return typeof it?.file === "string" &&
          SAFE_NAME.test(it.file) &&
          typeof it.name === "string"
          ? [{ file: it.file, name: it.name.slice(0, 40) }]
          : [];
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

export async function writePool(pool: LogoPool): Promise<void> {
  await getWebDb()
    .insert(siteSettings)
    .values({ key: KEY, value: pool, updatedAt: sqlNow() })
    .onDuplicateKeyUpdate({ set: { value: pool, updatedAt: sqlNow() } });
  invalidateSiteChrome();
}

export async function setActiveLogo(file: string): Promise<void> {
  const pool = await getLogoPoolRaw();
  if (!pool.items.some((i) => i.file === file)) return;
  await writePool({ ...pool, active: file });
}

/** 停用并移出池（文件保留在磁盘，误删可手工找回）；当前项被移除则回到 Wind 占位。 */
export async function removeLogo(file: string): Promise<void> {
  const pool = await getLogoPoolRaw();
  const items = pool.items.filter((i) => i.file !== file);
  await writePool({
    items,
    active: pool.active === file ? null : pool.active,
  });
}

/** 入池登记（DB 半）：由 fs 侧 addLogo 在写盘成功后调用。 */
export async function registerLogo(name: string, file: string): Promise<LogoPool> {
  const pool = await getLogoPoolRaw();
  const next: LogoPool = { items: [...pool.items, { file, name }], active: file };
  await writePool(next);
  return next;
}

/** 读取池内 LOGO 字节（/brand/logo）；不传 file 时取当前项，file 必须在池内；无可输出返回 null。 */
