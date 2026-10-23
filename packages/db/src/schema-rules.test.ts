import { int, mysqlTable, primaryKey, uniqueIndex, varchar, json } from "drizzle-orm/mysql-core";
import { describe, expect, it } from "vitest";
import * as schema from "./schema.js";
import { checkSchemaRules, collectTables, NULLABLE_UNIQUE_ALLOWLIST } from "./schema-rules.js";

describe("schema 结构规则（真实 schema）", () => {
  it("共 38 张表", () => {
    expect(collectTables(schema)).toHaveLength(38);
  });

  it("真实 schema 零违例", () => {
    expect(checkSchemaRules(schema)).toEqual([]);
  });

  it("可空唯一列白名单仅 users.email_key", () => {
    expect([...NULLABLE_UNIQUE_ALLOWLIST]).toEqual(["users.email_key"]);
  });
});

describe("schema 结构规则（反例必须被识别）", () => {
  it("多列唯一键含可空列（v1 role_grants 的根因）", () => {
    const bad = mysqlTable(
      "bad_grants",
      {
        id: int("id", { unsigned: true }).notNull().autoincrement(),
        roleKey: varchar("role_key", { length: 64 }).notNull(),
        forumId: int("forum_id", { unsigned: true }), // 可空
      },
      (t) => [primaryKey({ columns: [t.id] }), uniqueIndex("uq_bad").on(t.roleKey, t.forumId)],
    );
    const v = checkSchemaRules({ bad });
    expect(v.map((x) => x.rule)).toEqual(["no-nullable-unique"]);
    expect(v[0]?.detail).toContain("forum_id");
  });

  it("单列可空唯一键若不在白名单同样违例", () => {
    const bad = mysqlTable(
      "bad_single",
      {
        id: int("id", { unsigned: true }).notNull().autoincrement(),
        code: varchar("code", { length: 16 }),
      },
      (t) => [primaryKey({ columns: [t.id] }), uniqueIndex("uq_code").on(t.code)],
    );
    expect(checkSchemaRules({ bad }).map((x) => x.rule)).toEqual(["no-nullable-unique"]);
  });

  it("缺主键、保留 raw 归档列、整型 id 未自增", () => {
    const noPk = mysqlTable("no_pk", { name: varchar("name", { length: 8 }).notNull() });
    const rawCol = mysqlTable(
      "has_raw",
      { id: int("id").notNull().autoincrement(), raw: json("raw") },
      (t) => [primaryKey({ columns: [t.id] })],
    );
    const noAuto = mysqlTable("no_auto", { id: int("id").notNull() }, (t) => [
      primaryKey({ columns: [t.id] }),
    ]);
    const rules = checkSchemaRules({ noPk, rawCol, noAuto }).map((v) => `${v.table}:${v.rule}`);
    expect(rules).toContain("no_pk:primary-key");
    expect(rules).toContain("has_raw:no-archive-column");
    expect(rules).toContain("no_auto:auto-increment-id");
  });

  it("varchar 哈希主键 id（sessions）不要求自增", () => {
    const ok = mysqlTable("hash_pk", { id: varchar("id", { length: 64 }).notNull() }, (t) => [
      primaryKey({ columns: [t.id] }),
    ]);
    expect(checkSchemaRules({ ok })).toEqual([]);
  });
});
