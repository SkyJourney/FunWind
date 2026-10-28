// @vitest-environment node
/** 关注列表查询（M10.6d）：板块/用户两列表、按传入顺序排序、无头像回 null。 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { follows, getWebDb } from "@funwind/db";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { followedLists } from "./followed-lists";

let tdb: TempDb;

beforeAll(async () => {
  tdb = await setupTempDb({ demo: true });
});

afterAll(() => {
  tdb?.teardown();
});

describe.skipIf(skipDb)("关注列表查询（followed-lists）", () => {
  it("板块/用户两列表按传入顺序返回，头像键来自 files", async () => {
    const db = getWebDb();
    await db.delete(follows).where(eq(follows.userId, 90005)); // 隔离旧数据
    // member 关注 demo_admin(90004) 与 demo_alice(90001)（乱序传入验证排序）
    await db
      .insert(follows)
      .values([
        { userId: 90005, targetType: "user", targetId: 90004, createdAt: sql`NOW()` },
        { userId: 90005, targetType: "user", targetId: 90001, createdAt: sql`NOW()` },
        { userId: 90005, targetType: "forum", targetId: 902, createdAt: sql`NOW()` },
        { userId: 90005, targetType: "forum", targetId: 901, createdAt: sql`NOW()` },
      ])
      .onDuplicateKeyUpdate({ set: { userId: 90005 } });

    const { forums: fItems, users: uItems } = await followedLists(
      90005,
      [901, 902],
      [90004, 90001],
    );
    expect(fItems.map((f) => f.id)).toEqual([901, 902]); // 按传入顺序
    expect(fItems[0]?.threadCount).toBeGreaterThanOrEqual(0);
    expect(uItems.map((u) => u.id)).toEqual([90004, 90001]);
    expect(uItems[0]?.username).toBe("demo_admin");
  });

  it("空集合 → 两空列表", async () => {
    const r = await followedLists(90005, [], []);
    expect(r.forums).toEqual([]);
    expect(r.users).toEqual([]);
  });
});
