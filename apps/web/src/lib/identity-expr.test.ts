import { sql, type SQL } from "drizzle-orm";
import { alias, int, mysqlTable, varchar, MySqlDialect } from "drizzle-orm/mysql-core";
import { users } from "@funwind/db";
import { describe, expect, expectTypeOf, it } from "vitest";
import { publicUserDeleted, publicUserId, publicUsername } from "./identity-expr";

const dialect = new MySqlDialect();
const nullableIdentity = mysqlTable("nullable_identity", {
  id: int("id"),
  state: varchar("state", { length: 16 }),
  username: varchar("username", { length: 64 }),
});

const compile = (expression: SQL) => {
  const query = dialect.sqlToQuery(expression);
  return { sql: query.sql.replace(/\s+/g, " ").trim(), params: query.params };
};

const deletedSql = (table: string) =>
  `(${table}.\`id\` IS NOT NULL AND ( ${table}.\`state\` IS NULL OR ${table}.\`state\` = 'deleted' OR EXISTS ( SELECT 1 FROM account_deletion_requests adr WHERE adr.user_id = ${table}.\`id\` AND adr.status = 'completed' ) ))`;

describe("公开身份 SQL 表达式", () => {
  it.each([
    { label: "普通用户列", table: users, name: "`users`" },
    { label: "左连接的 nullable 列", table: nullableIdentity, name: "`nullable_identity`" },
    { label: "别名用户列", table: alias(users, "author"), name: "`author`" },
  ])(
    "$label：保留 UID 非空、缺失状态、deleted 和 completed tombstone 的 SQL",
    ({ table, name }) => {
      expect(compile(publicUserDeleted(table.id, table.state))).toEqual({
        sql: deletedSql(name),
        params: [],
      });
      expect(compile(publicUsername(table.username, table.state, table.id))).toEqual({
        sql: `CASE WHEN ${deletedSql(name)} THEN '已注销用户' ELSE ${name}.\`username\` END`,
        params: [],
      });
      expect(compile(publicUserId(table.id, table.state))).toEqual({
        sql: `CASE WHEN ${deletedSql(name)} THEN NULL ELSE ${name}.\`id\` END`,
        params: [],
      });
    },
  );

  it("公开身份只检查 completed；pending 不被并入读侧匿名口径，且可嵌入其他 SQL", () => {
    const expression = publicUserDeleted(nullableIdentity.id, nullableIdentity.state);
    const query = compile(sql`NOT ${expression}`);
    expect(query.sql).toBe(`NOT ${deletedSql("`nullable_identity`")}`);
    expect(query.sql).not.toContain("pending");
    expect(query.params).toEqual([]);
  });

  it("严格类型保留布尔标志及 nullable UID、名称", () => {
    expectTypeOf(publicUserDeleted(users.id, users.state)).toEqualTypeOf<SQL<boolean>>();
    expectTypeOf(publicUserId(users.id, users.state)).toEqualTypeOf<SQL<number | null>>();
    expectTypeOf(publicUsername(users.username, users.state, users.id)).toEqualTypeOf<
      SQL<string | null>
    >();
  });
});
