/**
 * schema 结构规则（M5.5）：把「唯一键不含可空列」「无 raw 归档列」等约定变成可执行断言。
 * 同时被 db:verify（对账脚本）与单测使用，约定因此不会只停留在文档里。
 */
import { is } from "drizzle-orm";
import { getTableConfig, MySqlTable } from "drizzle-orm/mysql-core";

export interface RuleViolation {
  table: string;
  rule: string;
  detail: string;
}

/**
 * 允许出现在唯一键里的可空列：仅限「单列唯一，且『空值 = 没有』本身是期望语义」。
 * 多个 NULL 不冲突正是 email_key 想要的行为（无邮箱用户不应互相冲突）。
 */
export const NULLABLE_UNIQUE_ALLOWLIST = new Set(["users.email_key"]);

/** 业务表禁止出现的归档列（旧行 JSON / 原始 UBB 正文双写已于 M5.5 取消） */
const FORBIDDEN_COLUMNS = new Set(["raw", "content_raw"]);

type AnyTable = Parameters<typeof getTableConfig>[0];

/** 收集 schema 模块导出的所有表 */
export function collectTables(schemaModule: Record<string, unknown>): AnyTable[] {
  const out: AnyTable[] = [];
  for (const value of Object.values(schemaModule)) {
    if (typeof value !== "object" || value === null) continue;
    // is() 运行时守卫排除 relations 等非表导出
    if (!is(value, MySqlTable)) continue;
    out.push(value as AnyTable);
  }
  return out;
}

export function checkSchemaRules(schemaModule: Record<string, unknown>): RuleViolation[] {
  const violations: RuleViolation[] = [];
  const add = (table: string, rule: string, detail: string) =>
    violations.push({ table, rule, detail });

  for (const table of collectTables(schemaModule)) {
    const cfg = getTableConfig(table);
    const name = cfg.name;
    const byName = new Map(cfg.columns.map((c) => [c.name, c]));

    // 1. 必须有主键（列级 primary 或表级 primaryKey）
    const pkCols = new Set<string>([
      ...cfg.columns.filter((c) => c.primary).map((c) => c.name),
      ...cfg.primaryKeys.flatMap((pk) => pk.columns.map((c) => c.name)),
    ]);
    if (pkCols.size === 0) add(name, "primary-key", "缺少主键");

    // 2. 禁止归档列
    for (const col of cfg.columns) {
      if (FORBIDDEN_COLUMNS.has(col.name)) add(name, "no-archive-column", `不得保留列 ${col.name}`);
    }

    // 3. 唯一键不得依赖 NULL 去重
    for (const idx of cfg.indexes) {
      if (!idx.config.unique) continue;
      const cols = idx.config.columns
        .map((c) => ("name" in c ? String(c.name) : null))
        .filter((n): n is string => n !== null);
      for (const colName of cols) {
        const col = byName.get(colName);
        if (!col || col.notNull) continue;
        const allowed = cols.length === 1 && NULLABLE_UNIQUE_ALLOWLIST.has(`${name}.${colName}`);
        if (!allowed) {
          add(
            name,
            "no-nullable-unique",
            `唯一索引 ${idx.config.name} 含可空列 ${colName}（MySQL 唯一键不去重 NULL；请用哨兵值并设 NOT NULL）`,
          );
        }
      }
    }

    // 4. 整型单列主键 id 必须自增（varchar 哈希主键如 sessions.id 不适用）
    if (pkCols.size === 1 && pkCols.has("id")) {
      const id = byName.get("id");
      const isInteger = id ? /int/i.test(id.getSQLType()) : false;
      // autoIncrement 在运行时存在于整型列实例，但未出现在 MySqlColumn 的公开类型上
      const autoIncrement = (id as unknown as { autoIncrement?: boolean } | undefined)
        ?.autoIncrement;
      if (id && isInteger && !autoIncrement) {
        add(name, "auto-increment-id", "整型主键 id 必须 AUTO_INCREMENT");
      }
    }
  }
  return violations;
}
