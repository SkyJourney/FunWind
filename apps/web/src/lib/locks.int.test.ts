// @vitest-environment node
import { and, eq, sql } from "drizzle-orm";
import { DEMO, getWebDb, users, userStats } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { lockUserStats } from "./locks";
import { POINTS_TX_OPTIONS, withDeadlockRetry } from "./points/retry";

let tdb: TempDb;

describe.skipIf(skipDb)("lockUserStats", () => {
  beforeAll(async () => {
    tdb = await setupTempDb();
  });

  afterAll(async () => {
    await tdb?.teardown();
  });
  it("补齐缺失 user_stats 行并持锁返回", async () => {
    const userId = DEMO.member;
    await getWebDb().delete(userStats).where(eq(userStats.userId, userId));

    await getWebDb().transaction(async (tx) => {
      await lockUserStats(tx, userId);
      const [row] = await tx.select().from(userStats).where(eq(userStats.userId, userId));
      expect(row).toMatchObject({
        userId,
        threadCount: 0,
        postCount: 0,
        featuredCount: 0,
        followerCount: 0,
        lastPostAt: null,
      });
      await lockUserStats(tx, userId);
    }, POINTS_TX_OPTIONS);
  });

  it.each([
    { label: "已存在行", userId: DEMO.team, missing: false },
    { label: "缺失行", userId: DEMO.alice, missing: true },
  ])(
    "$label：沿用调用方事务重试，16 路并发读改写不丢计数",
    async ({ userId, missing }) => {
      if (missing) await getWebDb().delete(userStats).where(eq(userStats.userId, userId));
      const [before] = await getWebDb()
        .select()
        .from(userStats)
        .where(eq(userStats.userId, userId));
      const initial = before?.postCount ?? 0;
      const total = 16;
      const results = await Promise.allSettled(
        Array.from({ length: total }, () =>
          // 缺行首次并发可能触发唯一键共享锁升级；与生产调用方一致，死锁时整体重放事务。
          withDeadlockRetry(() =>
            getWebDb().transaction(async (tx) => {
              await lockUserStats(tx, userId);
              const [row] = await tx
                .select({ postCount: userStats.postCount })
                .from(userStats)
                .where(eq(userStats.userId, userId));
              if (!row) throw new Error("持锁返回时统计行必须存在");
              await new Promise<void>((resolve) => setTimeout(resolve, 5));
              await tx
                .update(userStats)
                .set({ postCount: row.postCount + 1 })
                .where(eq(userStats.userId, userId));
              return row.postCount;
            }, POINTS_TX_OPTIONS),
          ),
        ),
      );
      expect(results.filter((result) => result.status === "rejected")).toEqual([]);
      const lockedCounts = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      expect(lockedCounts.sort((a, b) => a - b)).toEqual(
        Array.from({ length: total }, (_, index) => initial + index),
      );
      const rows = await getWebDb().select().from(userStats).where(eq(userStats.userId, userId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.postCount).toBe(initial + total);
    },
    30_000,
  );

  it("READ COMMITTED 下不同用户的缺失统计行并发创建，无间隙锁死锁且不重建", async () => {
    const userIds = Array.from({ length: 16 }, (_, index) => 1_100_000 + index);
    await getWebDb()
      .insert(users)
      .values(
        userIds.map((userId) => ({
          id: userId,
          username: `e2e_lock_${userId}`,
          usernameKey: `e2e_lock_${userId}`,
          createdAt: sql`NOW()`,
        })),
      );
    const results = await Promise.allSettled(
      userIds.map((userId) =>
        getWebDb().transaction(async (tx) => {
          await lockUserStats(tx, userId);
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          return userId;
        }, POINTS_TX_OPTIONS),
      ),
    );
    expect(results.filter((result) => result.status === "rejected")).toEqual([]);
    const rows = await getWebDb()
      .select({ userId: userStats.userId })
      .from(userStats)
      .where(
        and(
          sql`${userStats.userId} >= ${userIds[0]}`,
          sql`${userStats.userId} <= ${userIds.at(-1)}`,
        ),
      );
    expect(rows.map((row) => row.userId).sort((a, b) => a - b)).toEqual(userIds);
  }, 30_000);
});
