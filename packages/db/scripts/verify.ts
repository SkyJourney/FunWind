/**
 * db:verify —— bootstrap 产物对账（自更新期望：直接读 schema.ts 的表/列定义）
 * 检查项：
 *  1. 表全集一致（schema.ts 中 17 张表 ⇄ information_schema）
 *  2. 每表列名集合一致、列类型族一致（getSQLType() ⇄ COLUMN_TYPE 归一化对比）
 *  3. 引擎 InnoDB、表级字符集 utf8mb4
 *  4. 专项：users.username 列级 COLLATE utf8mb4_0900_as_cs（さくら≠サクラ）
 */
import { is } from "drizzle-orm";
import { getTableConfig, MySqlTable } from "drizzle-orm/mysql-core";
import type { RowDataPacket } from "mysql2/promise";
import { createPool } from "../src/client.js";
import { newDbConfig } from "../src/env.js";
import * as schema from "../src/schema.js";

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
  const out: ExpectedTable[] = [];
  for (const [key, value] of Object.entries(schema)) {
    void key;
    if (typeof value !== "object" || value === null) continue;
    // is() 运行时守卫排除 relations 等非表导出（drizzle 泛型不变性导致类型层无法收窄，此处豁免）
    if (!is(value, MySqlTable)) continue;
    const cfg = getTableConfig(value as Parameters<typeof getTableConfig>[0]);
    out.push({
      name: cfg.name,
      columns: cfg.columns.map((c) => ({ name: c.name, getSQLType: () => c.getSQLType() })),
    });
  }
  return out;
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

  // 4. 专项：username 列级 collation
  const [userCol] = await pool.query<ColInfoRow[]>(
    `SELECT COLUMN_NAME, COLUMN_TYPE, COLLATION_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'username'`,
    [config.database],
  );
  const u = userCol[0];
  add(
    "special:username collation",
    !!u && u.COLLATION_NAME === "utf8mb4_0900_as_cs",
    u ? `${u.COLLATION_NAME}（さくら≠サクラ红线）` : "users.username 不存在",
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
