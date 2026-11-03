// @vitest-environment node
import { inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import { accountDeletionRequests, getWebDb, users } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { publicUserDeleted, userNotClosing, userNotDeleted } from "./identity-expr";
import { lockActiveUserInTx } from "./identity";

let tdb: TempDb;
const db = () => getWebDb();
const firstId = 99881000;
const cases = [
  { label: "正常", state: "active", status: null, read: true, write: true, deleted: false },
  { label: "冷静期", state: "active", status: "pending", read: true, write: false, deleted: false },
  {
    label: "已取消",
    state: "active",
    status: "cancelled",
    read: true,
    write: true,
    deleted: false,
  },
  {
    label: "完成墓碑",
    state: "active",
    status: "completed",
    read: false,
    write: false,
    deleted: true,
  },
  { label: "已删除", state: "deleted", status: null, read: false, write: false, deleted: true },
] as const;

describe.skipIf(skipDb)("身份读写口径与单用户锁 · 真实 MySQL", () => {
  beforeAll(async () => {
    tdb = await setupTempDb({ demo: false });
    for (const [index, testCase] of cases.entries()) {
      const userId = firstId + index;
      await db()
        .insert(users)
        .values({
          id: userId,
          username: `identity_${userId}`,
          usernameKey: `identity_${userId}`,
          state: testCase.state,
          createdAt: "2026-01-01 00:00:00",
        });
      if (testCase.status !== null) {
        await db().insert(accountDeletionRequests).values({
          userId,
          status: testCase.status,
          requestedAt: "2026-01-01 00:00:00",
          scheduledAt: "2099-01-01 00:00:00",
        });
      }
    }
  });

  afterAll(async () => {
    await tdb?.teardown();
  });

  it.each(cases)("$label：公开匿名与封存写入不混用", async (testCase) => {
    const userId = firstId + cases.indexOf(testCase);
    const deletedRows = await db()
      .select({ id: users.id })
      .from(users)
      .where(sql`${users.id} = ${userId} AND ${publicUserDeleted(users.id, users.state)}`);
    expect(deletedRows.length > 0).toBe(testCase.deleted);
    const readable = await db()
      .select({ id: users.id })
      .from(users)
      .where(sql`${users.id} = ${userId} AND ${userNotDeleted(users.id, users.state)}`);
    const writable = await db()
      .select({ id: users.id })
      .from(users)
      .where(sql`${users.id} = ${userId} AND ${userNotClosing(users.id, users.state)}`);
    expect(readable.length > 0).toBe(testCase.read);
    expect(writable.length > 0).toBe(testCase.write);
    const result = await db().transaction((tx) => lockActiveUserInTx(tx, userId));
    expect(result).toEqual(
      testCase.write
        ? { ok: true, user: { id: userId, state: "active" } }
        : { ok: false, code: testCase.state === "deleted" ? "inactive" : "closing" },
    );
  });

  it("缺失用户单独返回 not_found，不把 nullable 匿名表达式当 active 叶子", async () => {
    expect(await db().transaction((tx) => lockActiveUserInTx(tx, firstId - 1))).toEqual({
      ok: false,
      code: "not_found",
    });
  });

  it("左连接缺失身份时，NOT 匿名判定为 true，不等价于必须 active 的两个叶子", async () => {
    const target = alias(users, "missing_target");
    const [row] = await db()
      .select({
        notAnonymous: sql<boolean>`NOT ${publicUserDeleted(target.id, target.state)}`.mapWith(
          Boolean,
        ),
        readable: userNotDeleted(target.id, target.state),
        writable: userNotClosing(target.id, target.state),
      })
      .from(users)
      .leftJoin(target, sql`${target.id} = ${firstId - 1}`)
      .where(sql`${users.id} = ${firstId}`);
    expect(row).toEqual({ notAnonymous: true, readable: null, writable: null });
  });

  it("同一用户有取消记录和 pending/completed 时仍按任一封存记录拒绝", async () => {
    const userId = firstId + 2;
    for (const status of ["pending", "completed"] as const) {
      await db().insert(accountDeletionRequests).values({
        userId,
        status,
        requestedAt: "2026-01-01 00:00:00",
        scheduledAt: "2099-01-01 00:00:00",
      });
    }
    const result = await db().transaction((tx) => lockActiveUserInTx(tx, userId));
    expect(result).toEqual({ ok: false, code: "closing" });
    const rows = await db()
      .select({ id: users.id })
      .from(users)
      .where(sql`${users.id} = ${userId} AND ${userNotDeleted(users.id, users.state)}`);
    expect(rows).toEqual([]);
    await db()
      .delete(accountDeletionRequests)
      .where(
        sql`${accountDeletionRequests.userId} = ${userId} AND ${inArray(accountDeletionRequests.status, ["pending", "completed"])}`,
      );
  });
});
