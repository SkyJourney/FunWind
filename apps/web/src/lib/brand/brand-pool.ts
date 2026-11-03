import { eq, sql } from "drizzle-orm";
import { getWebDb, siteSettings } from "@funwind/db";
import { CLI_ACTOR, writeAudit, type ConfigActor } from "@/lib/audit";
import { invalidateSiteChrome } from "@/lib/chrome/site-chrome";

/**
 * 品牌素材池核心（DB 半；M11 由 LOGO 池泛化，docs/THEME-SYSTEM.md 决策 8）：
 * LOGO / Hero 等「池 + 当前项」形态的站点素材共用这一套——池元数据存 site_settings 单键 JSON，
 * 写入在事务内 FOR UPDATE 读改写 + 前后值审计（无变化不记），提交后失效 chrome 缓存。
 * 素材不入附件授权管线（品牌位全端公开），文件由 fs 半（brand-pool-fs）写 STORAGE_DIR/site/。
 */

export interface BrandItem {
  /** 文件名（STORAGE_DIR/site/ 下，形如 <prefix>-<hex>.png） */
  file: string;
  name: string;
  /** 主题包自带素材的来源标签（lib/theme-packs 的 id）；联动按它去重、管理页显示「〈主题〉自带」徽标 */
  pack?: string;
}

export interface BrandPool {
  items: BrandItem[];
  active: string | null;
}

export interface BrandPoolSpec {
  /** site_settings 键，如 site.logo */
  key: string;
  /** 文件名前缀（SAFE_NAME = ^<prefix>-[a-z0-9]+\.png$），如 logo */
  prefix: string;
  /** 审计 targetType，如 logo */
  targetType: string;
  /** 审计动作前缀，如 admin.logo（→ .upload / .activate / .remove） */
  actionPrefix: string;
}

const SAFE_PACK = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function safeNameOf(prefix: string): RegExp {
  return new RegExp(`^${prefix}-[a-z0-9]+\\.png$`);
}

/** 池元数据校验：非法项丢弃、名称截 40、pack 标签不合法则去标签、active 不在清单归 null（悬空指针防护） */
export function parseBrandPool(raw: unknown, prefix: string): BrandPool {
  const safeName = safeNameOf(prefix);
  const o = raw as { items?: unknown; active?: unknown } | null;
  const items = Array.isArray(o?.items)
    ? o.items.flatMap((x) => {
        const it = x as Partial<BrandItem>;
        if (typeof it?.file !== "string" || !safeName.test(it.file) || typeof it.name !== "string")
          return [];
        const item: BrandItem = { file: it.file, name: it.name.slice(0, 40) };
        if (typeof it.pack === "string" && SAFE_PACK.test(it.pack)) item.pack = it.pack;
        return [item];
      })
    : [];
  const active = typeof o?.active === "string" ? o.active : null;
  return { items, active: items.some((i) => i.file === active) ? active : null };
}

export interface BrandPoolHandle {
  readonly spec: BrandPoolSpec;
  readonly safeName: RegExp;
  parse(raw: unknown): BrandPool;
  getRaw(): Promise<BrandPool>;
  setActive(file: string | null, actor?: ConfigActor): Promise<void>;
  /** 移出池（文件保留）；默认清空被移除的当前项，补偿指定 preserveActive 时拒绝删除当前项。 */
  remove(file: string, actor?: ConfigActor, opts?: { preserveActive?: boolean }): Promise<void>;
  /** 入池登记（DB 半）：由 fs 侧 add 在写盘成功后调用；pack = 主题包自带素材的来源标签 */
  register(
    name: string,
    file: string,
    actor?: ConfigActor,
    pack?: string,
    opts?: { preserveActive?: boolean },
  ): Promise<BrandPool>;
}

const sqlNow = () => sql`NOW()`;

export function createBrandPool(spec: BrandPoolSpec): BrandPoolHandle {
  const safeName = safeNameOf(spec.prefix);
  const parse = (raw: unknown) => parseBrandPool(raw, spec.prefix);

  async function getRaw(): Promise<BrandPool> {
    const [row] = await getWebDb()
      .select({ value: siteSettings.value })
      .from(siteSettings)
      .where(eq(siteSettings.key, spec.key))
      .limit(1);
    return parse(row?.value);
  }

  async function updatePool(
    change: (pool: BrandPool) => BrandPool,
    actor: ConfigActor,
    action: string,
    targetId: string,
  ): Promise<BrandPool> {
    const next = await getWebDb().transaction(async (tx) => {
      await tx
        .insert(siteSettings)
        .values({ key: spec.key, value: { items: [], active: null }, updatedAt: sqlNow() })
        .onDuplicateKeyUpdate({ set: { key: spec.key } });
      const [row] = await tx
        .select({ value: siteSettings.value })
        .from(siteSettings)
        .where(eq(siteSettings.key, spec.key))
        .for("update");
      const before = parse(row?.value);
      const after = change(before);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        await tx
          .update(siteSettings)
          .set({ value: after, updatedAt: sqlNow() })
          .where(eq(siteSettings.key, spec.key));
        await writeAudit(tx, {
          actorId: actor.userId,
          action,
          targetType: spec.targetType,
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

  return {
    spec,
    safeName,
    parse,
    getRaw,
    async setActive(file, actor = CLI_ACTOR) {
      await updatePool(
        (pool) =>
          file === null || pool.items.some((i) => i.file === file)
            ? { ...pool, active: file }
            : pool,
        actor,
        `${spec.actionPrefix}.activate`,
        file ?? "none",
      );
    },
    async remove(file, actor = CLI_ACTOR, opts = {}) {
      await updatePool(
        (pool) => {
          if (opts.preserveActive && pool.active === file) {
            throw new Error("active-asset-preserved");
          }
          return {
            items: pool.items.filter((i) => i.file !== file),
            active: pool.active === file ? null : pool.active,
          };
        },
        actor,
        `${spec.actionPrefix}.remove`,
        file,
      );
    },
    register(name, file, actor = CLI_ACTOR, pack, opts = {}) {
      return updatePool(
        (pool) => ({
          items: [...pool.items, pack ? { file, name, pack } : { file, name }],
          active: opts.preserveActive ? pool.active : file,
        }),
        actor,
        `${spec.actionPrefix}.upload`,
        file,
      );
    },
  };
}
