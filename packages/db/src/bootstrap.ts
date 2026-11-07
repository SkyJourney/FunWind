/**
 * bootstrapDb —— 空库建表管线（零数据部署与青翼导入共用，决策 #10）
 * 1. drizzle 版本化迁移（drizzle/ 下的版本化迁移，journal 断点续跑，幂等）
 * 2. PATCHES：drizzle-kit 不支持的列级 COLLATE（username_key / email_key / post_gates.gate_key 需 utf8mb4_bin），按需执行、幂等
 * 3. seedSystemData：内置角色、权限词汇表、基线授权、站点设置默认值——零数据站点开箱即有可用的权限体系
 */
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { createConnection, type RowDataPacket } from "mysql2/promise";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILTIN_ROLE_KEYS,
  DEFAULT_ROLE_GRANTS,
  DEFAULT_SITE_SETTINGS,
  PERMISSION_DEFINITIONS,
  ROLE_DEFINITIONS,
} from "./authz-vocab.js";
import { BUILTIN_THEME_PACK_SEEDS } from "./theme-pack-seeds.js";
import { THEME_PACK_VALUE_UPGRADES } from "./theme-pack-migrations.js";
import { backfillMissingSections, swapManyIfUnchanged } from "./theme-pack-upgrade.js";
import { createDb, createPool, type Db } from "./client.js";
import { newDbConfig } from "./env.js";
import { incoming } from "./sql.js";
import { permissions, roleGrants, roles, siteSettings, themePackages } from "./schema.js";

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
  {
    // 门控 key 在应用层区分大小写（KEY_RE 允许 A-Za-z），库里必须同口径：默认的 _ai_ci 下 A1 与 a1 会撞唯一键
    table: "post_gates",
    column: "gate_key",
    collation: "utf8mb4_bin",
    ddl: "varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL",
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
      `✔ 系统种子（幂等）：角色 ${summary.roles} / 权限点 ${summary.permissions} / 新增基线授权 ${summary.grantsInserted} / 新增默认设置 ${summary.settingsInserted} / 内置主题包 ${summary.themePacksInserted} / 补缺的内置主题包 ${summary.themePacksBackfilled} / 升级的内置主题包 ${summary.themePacksUpgraded}`,
    );
  } finally {
    await pool.end();
  }
}

/**
 * 连接测试（M12 安装管线「环境自检 / 数据库连接」步骤）：不指定 database 建连接并执行 SELECT 1。
 * 失败抛出原始错误，由安装管线翻译成「无法连接数据库」的提示。
 */
export async function pingDatabase(config = newDbConfig()): Promise<void> {
  const { database: _unused, ...withoutDb } = config;
  const conn = await createConnection(withoutDb);
  try {
    await conn.query("SELECT 1");
  } finally {
    await conn.end();
  }
}

/**
 * 建库（M12 安装管线专用）：IF NOT EXISTS，**绝不 DROP**——已存在的库原样返回。
 * 与 e2e-reset（测试重置语义：库名写死 `qysub_next_e2e` + 仅 loopback + DROP）完全不同：
 * 这里的目标库名由安装配置 schema 以 `^[A-Za-z0-9_]+$` 校验后传入，连接不指定 database。
 * 账号缺 CREATE 权限时抛出原始错误，由安装管线翻译成「请手动建库后重试」
 * （IF NOT EXISTS 语义下，手动建库后重跑本步骤自动通过）。
 */
export async function createDatabaseIfNotExists(
  config = newDbConfig(),
  database: string,
  log = (m: string) => console.log(m),
): Promise<void> {
  // 纵深防御：本函数以模板字符串拼接库名，调用方（web 安装 schema）有白名单校验，
  // 这里再自断言一次——公开导出的函数不信任调用链
  if (!/^[A-Za-z0-9_]{1,64}$/.test(database)) {
    throw new Error(`库名只允许字母、数字与下划线（1–64 位）：${database}`);
  }
  const { database: _unused, ...withoutDb } = config;
  const conn = await createConnection(withoutDb);
  try {
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    log(`✔ 数据库就绪：${database}`);
  } finally {
    await conn.end();
  }
}

export interface SystemSeedSummary {
  roles: number;
  permissions: number;
  grantsInserted: number;
  settingsInserted: number;
  themePacksInserted: number;
  /** 补上了缺失顶层段的内置主题包个数（M11.6 Step 4） */
  themePacksBackfilled: number;
  /** 按升级表替换了旧值的内置主题包升级次数（M11.6 Step 6；同一个包有多组升级时按组计） */
  themePacksUpgraded: number;
}

/**
 * 系统种子（幂等、非破坏性）：
 * - roles / permissions：按词汇表 upsert（词汇表是单一事实源）；不删除词汇表外的行（模块可能声明自有权限点）
 * - 基线授权：仅当某内置角色**尚无任何授权行**时写入默认值，避免重跑 bootstrap 覆盖管理员的授权调整
 *   （词汇表新增权限点对存量库的补授由增量迁移负责——见 drizzle/0005 的 EXISTS 守卫插入）
 * - 站点设置：仅写入缺失项，不覆盖已有值
 * - 内置主题包：行不存在才插入；已存在的内置行只补缺失的顶层段（backfillMissingSections），不覆盖已有段
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
      })),
    )
    .onDuplicateKeyUpdate({
      set: {
        resource: incoming("resource"),
        level: incoming("level"),
        description: incoming("description"),
      },
    });

  // 基线授权只在该角色没有任何授权行时整体插入（基线仅首次写入）：管理员调整过的授权不会被
  // 重跑 bootstrap 恢复（角色矩阵可编辑，bootstrap 幂等不覆盖人工调整；守卫 bootstrap.int.test）。
  // 新权限点对存量库的补齐 = 评估器对 admin 的短路放行（功能层）+ 一次性手工 INSERT（矩阵页显示）。
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

  // 内置主题包种子（M11.1）：只补缺（INSERT IGNORE 语义），站长在 /admin/themes 的编辑不被覆盖；
  // `default` 为系统回退包（不可删除/停用），qy2010 为内置情怀包（可编辑 definition）。
  let themePacksInserted = 0;
  for (const seed of BUILTIN_THEME_PACK_SEEDS) {
    const inserted = await db
      .insert(themePackages)
      .values({
        id: seed.id,
        name: seed.name,
        description: seed.description,
        schemaVersion: 1,
        definition: seed.definition,
        assets: [],
        enabled: true,
        isBuiltin: true,
        revision: 1,
        createdAt: sql`NOW()`,
        updatedAt: sql`NOW()`,
      })
      .onDuplicateKeyUpdate({ set: { id: seed.id } });
    if (inserted[0]?.affectedRows) themePacksInserted += Number(inserted[0].affectedRows);
  }

  // 内置主题包补缺（M11.6 Step 4）：存量行拿不到种子后来新增的顶层段（如 tokens），这里按段补上。
  // 只补缺失的段、永不覆盖已有的段，所以站长改过的内容不动；只处理仍是内置包的行
  // （同 id 的自定义行不是种子的，与 resetToBuiltin 的守卫同口径）。
  // 已知边角（设计 §3.4「缺段才补」）：站长把某个段整个清空也算缺失，下次会被补回
  // （例如令牌编辑器里把浅深两档都改回继承，会删掉 tokens 键）；不为它另加条件。
  const isBuiltinRow = async (id: string) => {
    const [row] = await db
      .select({ isBuiltin: themePackages.isBuiltin })
      .from(themePackages)
      .where(eq(themePackages.id, id))
      .limit(1);
    return row?.isBuiltin === true;
  };
  let themePacksBackfilled = 0;
  for (const seed of BUILTIN_THEME_PACK_SEEDS) {
    if (!(await isBuiltinRow(seed.id))) continue;
    if ((await backfillMissingSections(db, seed.id, seed.definition)) > 0)
      themePacksBackfilled += 1;
  }

  // 内置主题包值升级（M11.6 Step 6）：种子里的值有意改了（品牌色、次要文字色加深），
  // 存量行按升级表把旧值换成新值；路径上的值已被站长改过的跳过，缺失的路径不创建。
  // 必须在补缺之后：补缺会补上 pwa、tokens 等整段，升级才有路径可换（Step 4 之前的存量行没有这两段）。
  // 补缺补进来的段直接取自当前种子，已是新值，升级对它们是空操作。
  let themePacksUpgraded = 0;
  for (const upgrade of THEME_PACK_VALUE_UPGRADES) {
    if (!(await isBuiltinRow(upgrade.packId))) continue;
    if ((await swapManyIfUnchanged(db, upgrade.packId, upgrade.swaps)) > 0) themePacksUpgraded += 1;
  }

  return {
    roles: ROLE_DEFINITIONS.length,
    permissions: PERMISSION_DEFINITIONS.length,
    grantsInserted,
    settingsInserted,
    themePacksInserted,
    themePacksBackfilled,
    themePacksUpgraded,
  };
}
