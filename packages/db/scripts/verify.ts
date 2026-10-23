/**
 * db:verify —— bootstrap 产物对账（自更新期望：直接读 schema.ts 的表/列定义）
 * 检查项：
 *  0. schema 结构规则（唯一键无可空列 / 无 raw 归档列 / 自增 id / 有主键）——schema-rules.ts
 *  1. 表全集一致（schema.ts 全部表 ⇄ information_schema）
 *  2. 每表列名集合一致、列类型族一致（getSQLType() ⇄ COLUMN_TYPE 归一化对比）
 *  3. 引擎 InnoDB、表级字符集 utf8mb4
 *  4. 专项：列级 COLLATE 补丁（username_key / email_key 须为 utf8mb4_bin，さくら≠サクラ）
 *  5. 权限数据健康：role_grants / user_roles 中的角色键与权限点必须在 roles / 词汇表内（脏键零容忍）；
 *     系统种子已就位（内置角色 + 词汇表）
 */
import { getTableConfig } from "drizzle-orm/mysql-core";
import type { RowDataPacket } from "mysql2/promise";
import { PERMISSION_DEFINITIONS } from "../src/authz-vocab.js";
import { PATCHES } from "../src/bootstrap.js";
import { createPool } from "../src/client.js";
import { newDbConfig } from "../src/env.js";
import * as schema from "../src/schema.js";
import { checkSchemaRules, collectTables } from "../src/schema-rules.js";

const config = newDbConfig();
const pool = createPool(config);

interface ColInfoRow extends RowDataPacket {
  COLUMN_NAME: string;
  COLUMN_TYPE: string;
  COLLATION_NAME: string | null;
}

/** 表期望项：name + 列定义（列经 drizzle 泛型收口，此处用运行时形状规避泛型不变性） */
interface ExpectedTable {
  name: string;
  columns: { name: string; getSQLType(): string }[];
}

function expectedTables(): ExpectedTable[] {
  return collectTables(schema).map((table) => {
    const cfg = getTableConfig(table);
    return {
      name: cfg.name,
      columns: cfg.columns.map((c) => ({ name: c.name, getSQLType: () => c.getSQLType() })),
    };
  });
}

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** drizzle 的 boolean 生成 SQL "boolean"，MySQL 实际存储 tinyint(1) —— 视为等价 */
function typesEqual(expected: string, actual: string): boolean {
  const e = norm(expected);
  const a = norm(actual);
  if (e === a) return true;
  return (e === "boolean" && a === "tinyint(1)") || (e === "tinyint(1)" && a === "boolean");
}

const checks: { name: string; pass: boolean; detail: string }[] = [];
const add = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });

const tables = expectedTables();

{
  const violations = checkSchemaRules(schema);
  add(
    "rules:schema 结构规则",
    violations.length === 0,
    violations.length === 0
      ? `${tables.length} 表全部符合（唯一键无可空列 / 无 raw 归档列 / 自增 id / 有主键）`
      : violations
          .slice(0, 6)
          .map((v) => `${v.table}[${v.rule}] ${v.detail}`)
          .join("；"),
  );
}

try {
  // 1. 表全集
  const [tableRows] = await pool.query<RowDataPacket[]>(
    `SELECT TABLE_NAME, ENGINE, TABLE_COLLATION FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME <> '__drizzle_migrations'`,
    [config.database],
  );
  const dbTables = new Set(tableRows.map((r) => String(r.TABLE_NAME)));
  const expectedNames = new Set(tables.map((t) => t.name));
  const missing = [...expectedNames].filter((t) => !dbTables.has(t));
  const extra = [...dbTables].filter((t) => !expectedNames.has(t));
  add(
    "tables:全集一致",
    missing.length === 0 && extra.length === 0,
    `期望 ${expectedNames.size} 张；缺失 ${missing.length ? missing.join(",") : "无"}；多余 ${extra.length ? extra.join(",") : "无"}`,
  );

  // 2. 引擎与表级字符集
  const badEngine = tableRows.filter((r) => r.ENGINE !== "InnoDB").map((r) => String(r.TABLE_NAME));
  const badCharset = tableRows
    .filter((r) => !String(r.TABLE_COLLATION).startsWith("utf8mb4"))
    .map((r) => String(r.TABLE_NAME));
  add(
    "tables:InnoDB",
    badEngine.length === 0,
    badEngine.length ? `非 InnoDB: ${badEngine.join(",")}` : "全部 InnoDB",
  );
  add(
    "tables:utf8mb4",
    badCharset.length === 0,
    badCharset.length ? `非 utf8mb4: ${badCharset.join(",")}` : "全部 utf8mb4",
  );

  // 3. 逐表列对账
  let colFail = 0;
  const colDetails: string[] = [];
  for (const expectedTable of tables) {
    const tName = expectedTable.name;
    const [colRows] = await pool.query<ColInfoRow[]>(
      `SELECT COLUMN_NAME, COLUMN_TYPE, COLLATION_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [config.database, tName],
    );
    const dbCols = new Map(colRows.map((r) => [r.COLUMN_NAME, r]));
    const expectedCols = expectedTable.columns;
    const missingCols = expectedCols.filter((c) => !dbCols.has(c.name));
    const extraCols = [...dbCols.keys()].filter((n) => !expectedCols.some((c) => c.name === n));
    let typeMismatch = 0;
    for (const c of expectedCols) {
      const dbCol = dbCols.get(c.name);
      if (!dbCol) continue;
      const expectType = c.getSQLType();
      const actualType = dbCol.COLUMN_TYPE;
      if (!typesEqual(expectType, actualType)) {
        typeMismatch++;
        colDetails.push(`${tName}.${c.name}: 期望 ${expectType} 实际 ${actualType}`);
      }
    }
    if (missingCols.length || extraCols.length || typeMismatch) {
      colFail++;
      if (missingCols.length)
        colDetails.push(`${tName}: 缺列 ${missingCols.map((c) => c.name).join(",")}`);
      if (extraCols.length) colDetails.push(`${tName}: 多列 ${extraCols.join(",")}`);
    }
  }
  add(
    `columns:逐表对账（${tables.length} 表）`,
    colFail === 0,
    colFail === 0
      ? "全部列名与类型一致"
      : `${colFail} 表异常：${colDetails.slice(0, 6).join("；")}`,
  );

  // 4. 专项：列级 collation 补丁
  for (const p of PATCHES) {
    const [col] = await pool.query<ColInfoRow[]>(
      `SELECT COLUMN_NAME, COLUMN_TYPE, COLLATION_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [config.database, p.table, p.column],
    );
    const c = col[0];
    add(
      `special:${p.table}.${p.column}`,
      !!c && c.COLLATION_NAME === p.collation,
      c ? `${c.COLLATION_NAME}（精确比较，さくら≠サクラ红线）` : `${p.table}.${p.column} 不存在`,
    );
  }

  // 5. 权限数据健康 + 系统种子
  const [badRoles] = await pool.query<RowDataPacket[]>(
    `SELECT DISTINCT role_key AS k FROM (
       SELECT role_key FROM role_grants UNION SELECT role_key FROM user_roles
     ) x WHERE role_key NOT IN (SELECT \`key\` FROM roles)`,
  );
  add(
    "authz:角色键健康",
    badRoles.length === 0,
    badRoles.length ? `词汇外角色键: ${badRoles.map((r) => r.k).join(",")}` : "无脏角色键",
  );
  const [badPerms] = await pool.query<RowDataPacket[]>(
    `SELECT DISTINCT permission_key AS k FROM role_grants
     WHERE permission_key NOT IN (SELECT \`key\` FROM permissions)`,
  );
  add(
    "authz:权限点健康",
    badPerms.length === 0,
    badPerms.length ? `词汇外权限点: ${badPerms.map((r) => r.k).join(",")}` : "无脏权限点",
  );
  const [seedRows] = await pool.query<RowDataPacket[]>(
    `SELECT (SELECT COUNT(*) FROM roles WHERE kind = 'builtin') AS builtin,
            (SELECT COUNT(*) FROM permissions) AS perms`,
  );
  const seed = seedRows[0] as { builtin: number; perms: number };
  add(
    "seed:系统种子",
    Number(seed.builtin) >= 3 && Number(seed.perms) >= PERMISSION_DEFINITIONS.length,
    `内置角色 ${seed.builtin} / 权限点 ${seed.perms}（词汇表 ${PERMISSION_DEFINITIONS.length}）`,
  );
} finally {
  await pool.end();
}

console.log("\n========== db:verify 对账 ==========");
let fails = 0;
for (const c of checks) {
  if (!c.pass) fails++;
  console.log(`${c.pass ? "✔" : "✘"} ${c.name.padEnd(30)} ${c.detail}`);
}
console.log("====================================");
console.log(fails === 0 ? `全部通过（${checks.length} 项）` : `失败 ${fails}/${checks.length} 项`);
process.exit(fails === 0 ? 0 : 1);
