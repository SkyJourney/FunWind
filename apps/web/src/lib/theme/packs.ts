import { eq, sql } from "drizzle-orm";
import { getWebDb, siteSettings, themePackages } from "@funwind/db";
import { writeAudit, type ConfigActor, type DbTx } from "@/lib/audit";
import { invalidateThemeCatalog } from "@/lib/theme/catalog";
import { parseThemePackDefinition, type ThemePackDefinition } from "@/lib/theme/surface-schema";

/**
 * 主题包写服务（M11.1 Step 5，docs/milestones/M11.1-theme-engine.md Step 5）：
 * 包的新建/更新/启停/复制/删除 + 站点默认切换，全部在事务内写包行与审计（同事务：动作回滚则审计一并回滚）。
 * 并发控制用 revision 乐观锁：编辑方提交时带上读到的 revision，不一致即报冲突（不覆盖他人改动）。
 *
 * 保护规则：
 *  · `default` 是系统回退包：不可删除、不可停用（enabled 恒真）；
 *  · 内置包（is_builtin）可编辑 definition、不可删除；
 *  · 停用/删除被站点默认或用户偏好引用时，按「无效 → 回退 default」处理（读侧目录校验），不硬改用户数据。
 */

export const THEME_PACK_ID_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
/** 保留字：default 是系统回退包；dark/system 与明暗模式轴冲突，不做包 id */
export const RESERVED_PACK_IDS = new Set(["default", "dark", "system"]);

export type ThemePackRow = typeof themePackages.$inferSelect;

export interface ThemePackSummary {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  isBuiltin: boolean;
  revision: number;
  surfaces: number;
  /** assets 清单条数（LOGO + decor 引用） */
  assetCount: number;
  updatedAt: string;
}

export type ThemePackErrorCode =
  | "bad-id"
  | "bad-name"
  | "missing-assets"
  | "reserved-id"
  | "not-found"
  | "conflict"
  | "protected"
  | "invalid-definition"
  | "duplicate-id";

export interface ThemePackResult<T = ThemePackSummary> {
  ok: boolean;
  code?: ThemePackErrorCode;
  errors?: string[];
  value?: T;
}

/** 包资产引用：文件留在共享素材池，包内只保存受限文件名和可选校验信息 */
export interface ThemePackAsset {
  kind: "logo" | "decor";
  poolFile: string;
  sha256?: string;
  bytes?: number;
}

function toSummary(row: ThemePackRow): ThemePackSummary {
  const definition = row.definition as { surfaces?: Record<string, unknown> } | null;
  const assets = Array.isArray(row.assets) ? row.assets : [];
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    isBuiltin: row.isBuiltin,
    revision: row.revision,
    surfaces: Object.keys(definition?.surfaces ?? {}).length,
    assetCount: assets.length,
    updatedAt: row.updatedAt,
  };
}

async function lockThemePack(tx: DbTx, id: string): Promise<ThemePackRow | null> {
  const [row] = await tx
    .select()
    .from(themePackages)
    .where(eq(themePackages.id, id))
    .limit(1)
    .for("update");
  return row ?? null;
}

async function auditThemePackChange(
  tx: DbTx,
  actor: ConfigActor,
  action: string,
  id: string,
  before?: unknown,
  after?: unknown,
): Promise<void> {
  await writeAudit(tx, {
    actorId: actor.userId,
    action,
    targetType: "theme_pack",
    targetId: id,
    before,
    after,
    ip: actor.ip,
  });
}

function withRevision(revision: number, values: Record<string, unknown>) {
  return { ...values, revision };
}

async function auditRevisionChange(
  tx: DbTx,
  actor: ConfigActor,
  action: string,
  id: string,
  beforeRevision: number,
  before: Record<string, unknown>,
  afterRevision: number,
  after: Record<string, unknown>,
): Promise<void> {
  await auditThemePackChange(
    tx,
    actor,
    action,
    id,
    withRevision(beforeRevision, before),
    withRevision(afterRevision, after),
  );
}

function auditThemePackToggle(
  tx: DbTx,
  actor: ConfigActor,
  id: string,
  before: ThemePackRow,
  after: ThemePackRow,
  enabled: boolean,
) {
  return auditRevisionChange(
    tx,
    actor,
    "theme.pack.toggle",
    id,
    before.revision,
    { enabled: before.enabled },
    after.revision,
    { enabled },
  );
}

/** 包列表（管理页用）：内置包在前，同组按 id 排序 */
export async function listThemePacks(): Promise<ThemePackSummary[]> {
  const rows = await getWebDb().select().from(themePackages);
  return rows
    .map(toSummary)
    .sort((a, b) => Number(b.isBuiltin) - Number(a.isBuiltin) || a.id.localeCompare(b.id));
}

/** 单包（编辑页用） */
export async function getThemePack(id: string): Promise<ThemePackRow | null> {
  const [row] = await getWebDb()
    .select()
    .from(themePackages)
    .where(eq(themePackages.id, id))
    .limit(1);
  return row ?? null;
}

/** 校验包 id */
export function validatePackId(id: string): ThemePackErrorCode | null {
  if (!THEME_PACK_ID_RE.test(id)) return "bad-id";
  if (RESERVED_PACK_IDS.has(id)) return "reserved-id";
  return null;
}

/** 从定义中提取 decor 引用，包目录不接收任意路径 */
export function getThemePackDecorRefs(definition: ThemePackDefinition): string[] {
  const refs = new Set<string>();
  for (const entry of Object.values(definition.surfaces)) {
    for (const mode of [entry.light, entry.dark]) {
      if (!mode) continue;
      if (mode.fill?.type === "image") refs.add(mode.fill.asset);
      if (mode.overlay?.type === "image") refs.add(mode.overlay.asset);
      if (mode.contentSlot?.image) refs.add(mode.contentSlot.image);
    }
  }
  return [...refs].sort();
}

/** 单个素材的引用去向（管理页徽标/删除确认用） */
export interface DecorUsage {
  packId: string;
  packName: string;
  surfaceIds: string[];
}

/**
 * 全库 decor 引用图谱：decorFile → 引用它的主题包与 Surface 列表。
 * 只统计 enabled 与否无关（停用包仍引用文件，删除保护同样生效）。
 */
export async function getDecorUsage(): Promise<Map<string, DecorUsage[]>> {
  const rows = await getWebDb()
    .select({
      id: themePackages.id,
      name: themePackages.name,
      definition: themePackages.definition,
    })
    .from(themePackages);
  const usage = new Map<string, DecorUsage[]>();
  for (const row of rows) {
    const parsed = parseThemePackDefinition(row.definition);
    if (!parsed.ok) continue;
    for (const [surfaceId, entry] of Object.entries(parsed.value.surfaces)) {
      const files = new Set<string>();
      for (const mode of [entry.light, entry.dark]) {
        if (!mode) continue;
        if (mode.fill?.type === "image") files.add(mode.fill.asset);
        if (mode.overlay?.type === "image") files.add(mode.overlay.asset);
        if (mode.contentSlot?.image) files.add(mode.contentSlot.image);
      }
      for (const file of files) {
        const list = usage.get(file) ?? [];
        const existing = list.find((u) => u.packId === row.id);
        if (existing) {
          existing.surfaceIds.push(surfaceId);
        } else {
          list.push({ packId: row.id, packName: row.name, surfaceIds: [surfaceId] });
        }
        usage.set(file, list);
      }
    }
  }
  return usage;
}

function assetsForDefinition(
  rawAssets: unknown,
  definition: ThemePackDefinition,
): ThemePackAsset[] {
  const logos = parseThemePackAssets(rawAssets).filter((asset) => asset.kind === "logo");
  const decor = getThemePackDecorRefs(definition).map((poolFile) => ({
    kind: "decor" as const,
    poolFile,
  }));
  return [...logos, ...decor];
}

export interface CreateThemePackInput {
  id: string;
  name: string;
  description?: string;
  definition: unknown;
  assets?: unknown;
  actor: ConfigActor;
}

export async function createThemePack(input: CreateThemePackInput): Promise<ThemePackResult> {
  const idError = validatePackId(input.id);
  if (idError) return { ok: false, code: idError };
  const name = input.name.trim();
  if (!name) return { ok: false, code: "bad-name" };
  const parsed = parseThemePackDefinition(input.definition);
  if (!parsed.ok) return { ok: false, code: "invalid-definition", errors: parsed.errors };

  const value = await getWebDb().transaction(async (tx) => {
    if (await lockThemePack(tx, input.id)) {
      return { ok: false as const, code: "duplicate-id" as const };
    }

    await tx.insert(themePackages).values({
      id: input.id,
      name: name.slice(0, 60),
      description: (input.description ?? "").trim().slice(0, 200),
      schemaVersion: 1,
      definition: parsed.value,
      assets: assetsForDefinition(input.assets, parsed.value),
      enabled: true,
      isBuiltin: false,
      revision: 1,
      createdAt: sql`NOW()`,
      updatedAt: sql`NOW()`,
    });
    const row = (await lockThemePack(tx, input.id))!;
    await auditThemePackChange(tx, input.actor, "theme.pack.create", input.id, undefined, {
      id: input.id,
      name: row.name,
      revision: row.revision,
    });
    return { ok: true as const, value: toSummary(row) };
  });
  if (value.ok) invalidateThemeCatalog();
  return value;
}

export interface UpdateThemePackInput {
  id: string;
  /** 读到的 revision；与库内不一致 → conflict（不覆盖他人改动） */
  expectedRevision: number;
  name?: string;
  description?: string;
  definition?: unknown;
  actor: ConfigActor;
}

export async function updateThemePack(input: UpdateThemePackInput): Promise<ThemePackResult> {
  const name = input.name?.trim();
  if (input.name !== undefined && !name) return { ok: false, code: "bad-name" };
  const parsed = input.definition === undefined ? null : parseThemePackDefinition(input.definition);
  if (parsed && !parsed.ok) {
    return { ok: false, code: "invalid-definition", errors: parsed.errors };
  }

  const value = await getWebDb().transaction(async (tx) => {
    const row = await lockThemePack(tx, input.id);
    if (!row) return { ok: false as const, code: "not-found" as const };
    if (row.revision !== input.expectedRevision) {
      return { ok: false as const, code: "conflict" as const };
    }
    const nextName = (name ?? row.name).slice(0, 60);
    const nextDescription = (input.description ?? row.description).trim().slice(0, 200);
    const definitionResult = parsed ?? parseThemePackDefinition(row.definition);
    if (!definitionResult.ok) {
      return {
        ok: false as const,
        code: "invalid-definition" as const,
        errors: definitionResult.errors,
      };
    }
    const nextDefinition = definitionResult.value;
    await tx
      .update(themePackages)
      .set({
        name: nextName,
        description: nextDescription,
        definition: nextDefinition,
        assets: assetsForDefinition(row.assets, nextDefinition),
        revision: row.revision + 1,
        updatedAt: sql`NOW()`,
      })
      .where(eq(themePackages.id, input.id));
    const updated = (await lockThemePack(tx, input.id))!;
    await auditRevisionChange(
      tx,
      input.actor,
      "theme.pack.update",
      input.id,
      row.revision,
      { name: row.name, description: row.description },
      updated.revision,
      { name: nextName, description: nextDescription },
    );
    return { ok: true as const, value: toSummary(updated) };
  });
  if (value.ok) invalidateThemeCatalog();
  return value;
}

/** 启停：default 不可停用 */
export async function setThemePackEnabled(
  id: string,
  enabled: boolean,
  actor: ConfigActor,
): Promise<ThemePackResult> {
  const value = await getWebDb().transaction(async (tx) => {
    const row = await lockThemePack(tx, id);
    if (!row) return { ok: false as const, code: "not-found" as const };
    if (!enabled && id === "default") return { ok: false as const, code: "protected" as const };
    if (row.enabled === enabled) return { ok: true as const, value: toSummary(row) };
    await tx
      .update(themePackages)
      .set({ enabled, revision: row.revision + 1, updatedAt: sql`NOW()` })
      .where(eq(themePackages.id, id));
    const updated = (await lockThemePack(tx, id))!;
    await auditThemePackToggle(tx, actor, id, row, updated, enabled);
    return { ok: true as const, value: toSummary(updated) };
  });
  if (value.ok) invalidateThemeCatalog();
  return value;
}

/** 删除：内置包不可删；default 不可删 */
export async function deleteThemePack(
  id: string,
  actor: ConfigActor,
): Promise<ThemePackResult<{ id: string; name: string }>> {
  const value = await getWebDb().transaction(async (tx) => {
    const row = await lockThemePack(tx, id);
    if (!row) return { ok: false as const, code: "not-found" as const };
    if (row.isBuiltin || id === "default")
      return { ok: false as const, code: "protected" as const };
    await tx.delete(themePackages).where(eq(themePackages.id, id));
    await auditThemePackChange(tx, actor, "theme.pack.delete", id, {
      id: row.id,
      name: row.name,
      revision: row.revision,
    });
    return { ok: true as const, value: { id, name: row.name } };
  });
  if (value.ok) invalidateThemeCatalog();
  return value;
}

/** 复制：以现有包为模板新建一个自定义包（新 id） */
export async function copyThemePack(
  sourceId: string,
  newId: string,
  actor: ConfigActor,
): Promise<ThemePackResult> {
  const idError = validatePackId(newId);
  if (idError) return { ok: false, code: idError };
  const source = await getThemePack(sourceId);
  if (!source) return { ok: false, code: "not-found" };
  return createThemePack({
    id: newId,
    name: `${source.name} 副本`.slice(0, 60),
    description: source.description,
    definition: source.definition,
    assets: source.assets,
    actor,
  });
}

/**
 * 设置/清除主题自带 LOGO（M11.1 Step 7 编辑工作区）：poolFile 必须已在 LOGO 池；
 * null = 清除。只替换 assets 中 kind=logo 的项（decor 引用不动），revision +1、审计可追溯。
 */
export async function setThemePackLogo(
  packId: string,
  poolFile: string | null,
  actor: ConfigActor,
): Promise<ThemePackResult> {
  const value = await getWebDb().transaction(async (tx) => {
    const row = await lockThemePack(tx, packId);
    if (!row) return { ok: false as const, code: "not-found" as const };
    if (poolFile !== null) {
      const [known] = await tx
        .select({ value: siteSettings.value })
        .from(siteSettings)
        .where(eq(siteSettings.key, "site.logo"))
        .limit(1);
      const pool = known?.value as { items?: unknown } | null | undefined;
      const items = (Array.isArray(pool?.items) ? pool.items : []) as { file?: unknown }[];
      if (!items.some((item) => item.file === poolFile)) {
        return { ok: false as const, code: "missing-assets" as const };
      }
    }
    const beforeAssets = parseThemePackAssets(row.assets);
    const decor = beforeAssets.filter((asset) => asset.kind === "decor");
    const nextAssets = poolFile
      ? [
          ...beforeAssets.filter((asset) => asset.kind === "logo" && asset.poolFile === poolFile),
          ...decor,
        ]
      : decor;
    if (poolFile && !nextAssets.some((asset) => asset.kind === "logo")) {
      nextAssets.unshift({ kind: "logo", poolFile });
    }
    await tx
      .update(themePackages)
      .set({
        assets: nextAssets,
        revision: row.revision + 1,
        updatedAt: sql`NOW()`,
      })
      .where(eq(themePackages.id, packId));
    await auditRevisionChange(
      tx,
      actor,
      "theme.pack.logo",
      packId,
      row.revision,
      { logo: beforeAssets.find((asset) => asset.kind === "logo")?.poolFile ?? null },
      row.revision + 1,
      { logo: poolFile },
    );
    return {
      ok: true as const,
      value: toSummary({ ...row, assets: nextAssets, revision: row.revision + 1 }),
    };
  });
  if (value.ok) invalidateThemeCatalog();
  return value;
}

/** 解析受限资产清单，忽略损坏条目和未知字段 */
export function parseThemePackAssets(raw: unknown): ThemePackAsset[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const item = value as { kind?: unknown; poolFile?: unknown; sha256?: unknown; bytes?: unknown };
    if (item.kind !== "logo" && item.kind !== "decor") return [];
    const prefix = item.kind === "decor" ? "decor" : "logo";
    if (
      typeof item.poolFile !== "string" ||
      !new RegExp(`^${prefix}-[a-f0-9]{32}\\.png$`).test(item.poolFile)
    ) {
      return [];
    }
    const asset: ThemePackAsset = { kind: item.kind, poolFile: item.poolFile };
    if (typeof item.sha256 === "string" && /^[a-f0-9]{64}$/i.test(item.sha256)) {
      asset.sha256 = item.sha256.toLowerCase();
    }
    if (typeof item.bytes === "number" && Number.isSafeInteger(item.bytes) && item.bytes >= 0) {
      asset.bytes = item.bytes;
    }
    return [asset];
  });
}

/** 站点默认主题切换（site.theme）：包状态检查、设置写入和审计在同一事务中完成 */
export async function setSiteDefaultThemePack(
  packId: string,
  actor: ConfigActor,
): Promise<ThemePackResult<{ pack: string }>> {
  const result = await getWebDb().transaction(async (tx) => {
    const pack = await lockThemePack(tx, packId);
    if (!pack) return { ok: false as const, code: "not-found" as const };
    if (!pack.enabled) return { ok: false as const, code: "protected" as const };

    const [previous] = await tx
      .select({ value: siteSettings.value })
      .from(siteSettings)
      .where(eq(siteSettings.key, "site.theme"))
      .limit(1)
      .for("update");
    const value = { pack: packId };
    await tx
      .insert(siteSettings)
      .values({ key: "site.theme", value, updatedAt: sql`NOW()` })
      .onDuplicateKeyUpdate({ set: { value, updatedAt: sql`NOW()` } });
    if (JSON.stringify(previous?.value) !== JSON.stringify(value)) {
      await writeAudit(tx, {
        actorId: actor.userId,
        action: "setting.update",
        targetType: "setting",
        targetId: "site.theme",
        before: previous ? { value: previous.value } : null,
        after: { value, via: actor.via },
        ip: actor.ip,
      });
    }
    return { ok: true as const, value: { pack: packId } };
  });
  if (result.ok) invalidateThemeCatalog();
  return result;
}

/** 站点默认包当前 id；无效或缺省值由目录回退链处理 */
export async function getSiteDefaultThemePack(): Promise<string> {
  const [row] = await getWebDb()
    .select({ value: siteSettings.value })
    .from(siteSettings)
    .where(eq(siteSettings.key, "site.theme"))
    .limit(1);
  const pack = (row?.value as { pack?: unknown } | undefined)?.pack;
  return typeof pack === "string" ? pack : "default";
}
