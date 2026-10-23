/**
 * bootstrapDb —— 空库建表管线（零数据部署与青翼导入共用，决策 #10）
 * 1. drizzle 版本化迁移（drizzle/0000_init_v2.sql，journal 断点续跑，幂等）
 * 2. PATCHES：drizzle-kit 不支持的列级 COLLATE（username_key / email_key 需 utf8mb4_bin），按需执行、幂等
 * 3. seedSystemData：内置角色、权限词汇表、基线授权、站点设置默认值——零数据站点开箱即有可用的权限体系
 */
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/mysql2/migrator";
import type { RowDataPacket } from "mysql2/promise";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILTIN_ROLE_KEYS,
  DEFAULT_ROLE_GRANTS,
  DEFAULT_SITE_SETTINGS,
  PERMISSION_DEFINITIONS,
  ROLE_DEFINITIONS,
} from "./authz-vocab.js";
import { createDb, createPool, type Db } from "./client.js";
import { newDbConfig } from "./env.js";
import { incoming } from "./sql.js";
import { permissions, roleGrants, roles, siteSettings } from "./schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, "../drizzle");

/** 列级排序规则补丁：归一化键需要精确（二进制）比较，さくら≠サクラ */
export const PATCHES = [
  {
    table: "users",
    column: "username_key",
    collation: "utf8mb4_bin",
    ddl: "varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL",
  },
  {
    table: "users",
    column: "email_key",
    collation: "utf8mb4_bin",
    ddl: "varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL",
  },
] as const;

export async function bootstrapDb(
  config = newDbConfig(),
  log = (m: string) => console.log(m),
): Promise<void> {
  const pool = createPool(config);
  const db = createDb(pool);
  try {
    await migrate(db, { migrationsFolder });
    log("✔ 版本化迁移已应用（幂等）");

    for (const p of PATCHES) {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT COLLATION_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [config.database, p.table, p.column],
      );
      const collation = rows[0]?.COLLATION_NAME;
      if (collation === p.collation) {
        log(`✔ ${p.table}.${p.column} 已是 ${p.collation}（patch 跳过）`);
      } else {
        await pool.query(`ALTER TABLE \`${p.table}\` MODIFY \`${p.column}\` ${p.ddl}`);
        log(`✔ ${p.table}.${p.column} collation 修正：${collation} → ${p.collation}`);
      }
    }

    const summary = await seedSystemData(db);
    log(
      `✔ 系统种子（幂等）：角色 ${summary.roles} / 权限点 ${summary.permissions} / 新增基线授权 ${summary.grantsInserted} / 新增默认设置 ${summary.settingsInserted}`,
    );
  } finally {
    await pool.end();
  }
}

export interface SystemSeedSummary {
  roles: number;
  permissions: number;
  grantsInserted: number;
  settingsInserted: number;
}

/**
 * 系统种子（幂等、非破坏性）：
 * - roles / permissions：按词汇表 upsert（词汇表是单一事实源）；不删除词汇表外的行（模块可能声明自有权限点）
 * - 基线授权：仅当某内置角色**尚无任何授权行**时写入默认值，避免重跑 bootstrap 覆盖管理员的授权调整
 * - 站点设置：仅写入缺失项，不覆盖已有值
 */
export async function seedSystemData(db: Db): Promise<SystemSeedSummary> {
  await db
    .insert(roles)
    .values(
      ROLE_DEFINITIONS.map((r) => ({
        key: r.key,
        name: r.name,
        kind: r.kind,
        description: r.description,
      })),
    )
    .onDuplicateKeyUpdate({
      set: {
        name: incoming("name"),
        kind: incoming("kind"),
        description: incoming("description"),
      },
    });

  await db
    .insert(permissions)
    .values(
      PERMISSION_DEFINITIONS.map((p) => ({
        key: p.key,
        resource: p.resource,
        level: p.level,
        description: p.description,
        legacyKey: p.legacyKey,
        conditionParams: p.conditionParams ?? null,
      })),
    )
    .onDuplicateKeyUpdate({
      set: {
        resource: incoming("resource"),
        level: incoming("level"),
        description: incoming("description"),
        legacyKey: incoming("legacy_key"),
        conditionParams: incoming("condition_params"),
      },
    });

  let grantsInserted = 0;
  for (const roleKey of BUILTIN_ROLE_KEYS) {
    const existing = await db
      .select({ id: roleGrants.id })
      .from(roleGrants)
      .where(eq(roleGrants.roleKey, roleKey))
      .limit(1);
    if (existing.length > 0) continue;
    const rows = DEFAULT_ROLE_GRANTS[roleKey].map((permissionKey) => ({
      roleKey,
      permissionKey,
      scopeId: 0,
    }));
    await db.insert(roleGrants).values(rows);
    grantsInserted += rows.length;
  }

  const existingKeys = new Set(
    (await db.select({ key: siteSettings.key }).from(siteSettings)).map((r) => r.key),
  );
  const missing = Object.entries(DEFAULT_SITE_SETTINGS).filter(([key]) => !existingKeys.has(key));
  if (missing.length > 0) {
    await db
      .insert(siteSettings)
      .values(
        missing.map(([key, value]) => ({ key, value: value as object, updatedAt: sql`NOW()` })),
      );
  }
  const settingsInserted = missing.length;

  return {
    roles: ROLE_DEFINITIONS.length,
    permissions: PERMISSION_DEFINITIONS.length,
    grantsInserted,
    settingsInserted,
  };
}
