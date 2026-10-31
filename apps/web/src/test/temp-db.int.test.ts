// @vitest-environment node
import mysql from "mysql2/promise";
import { newDbConfig } from "@funwind/db";
import { describe, expect, it } from "vitest";
import { setupTempDb, skipDb } from "./temp-db";

describe.skipIf(skipDb)("临时测试库清理", () => {
  it("并发 teardown 幂等、恢复 NEW_DB_NAME 并删除临时库", async () => {
    newDbConfig();
    const previousDbName = process.env.NEW_DB_NAME;
    const tempDb = await setupTempDb({ demo: false });
    try {
      expect(process.env.NEW_DB_NAME).toBe(tempDb.name);
      await Promise.all([tempDb.teardown(), tempDb.teardown()]);
      expect(process.env.NEW_DB_NAME).toBe(previousDbName);

      const conn = await mysql.createConnection({
        ...newDbConfig(),
        database: "information_schema",
      });
      try {
        const [rows] = await conn.query("SELECT SCHEMA_NAME FROM SCHEMATA WHERE SCHEMA_NAME = ?", [
          tempDb.name,
        ]);
        expect(rows).toHaveLength(0);
      } finally {
        await conn.end();
      }
    } finally {
      await tempDb.teardown();
    }
  }, 30_000);
});
