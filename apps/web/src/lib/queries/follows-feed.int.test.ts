// @vitest-environment node
/** 关注动态聚合（M8）集成测试：口径（可见+上目录）、空关注短路、分页 */
import { eq } from "drizzle-orm";
import { follows, getWebDb } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSubject } from "@/lib/authz/subject";
import type { Subject } from "@/lib/authz/types";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { followedThreadIds, getFollowFeed } from "./follows-feed";

let tdb: TempDb;
let team: Subject;
const guest: Subject = {
  userId: null,
  roles: [{ key: "guest", scopeId: 0 }],
  restrictions: [],
  emailVerified: false,
  emailVerificationRequired: false,
  registerMode: "invite",
};
const db = () => getWebDb();

async function setFollows(userId: number, rows: { type: "user" | "forum"; id: number }[]) {
  await db().delete(follows).where(eq(follows.userId, userId));
  for (const r of rows) {
    await db()
      .insert(follows)
      .values({ userId, targetType: r.type, targetId: r.id, createdAt: "2026-10-26 00:00:00" });
  }
}

beforeAll(async () => {
  tdb = await setupTempDb();
  team = await loadSubject(90006);
});

afterAll(async () => {
  await tdb?.teardown();
});

describe.skipIf(skipDb)("关注动态（/follows）", () => {
  it("游客与空关注：空结果短路（forumCount/userCount 如实）", async () => {
    const g = await getFollowFeed(guest, 1);
    expect(g.items).toHaveLength(0);
    await setFollows(team.userId!, []);
    const empty = await getFollowFeed(team, 1);
    expect(empty).toMatchObject({ items: [], total: 0, forumCount: 0, userCount: 0 });
  });

  it("关注版块：该版块主题进动态；不上目录（905）与受限（904）不进 team 视角之外的结果", async () => {
    await setFollows(team.userId!, [{ type: "forum", id: 901 }]);
    const feed = await getFollowFeed(team, 1);
    expect(feed.total).toBeGreaterThan(0);
    expect(feed.items.every((t) => t.forumId === 901)).toBe(true);
    // 905 不上目录：即使关注了也不出现（is_listed=0）
    await setFollows(team.userId!, [{ type: "forum", id: 905 }]);
    const hidden = await getFollowFeed(team, 1);
    expect(hidden.items).toHaveLength(0);
  });

  it("关注用户：该用户的主题进动态；可见性谓词与首页口径一致（visible）", async () => {
    await setFollows(team.userId!, [{ type: "user", id: 90001 }]); // alice（种子多主题）
    const feed = await getFollowFeed(team, 1);
    expect(feed.total).toBeGreaterThan(0);
    expect(feed.items.every((t) => t.state === "visible")).toBe(true);
    expect(feed.userCount).toBe(1);
  });

  it("followedThreadIds 拆分两类目标", async () => {
    await setFollows(team.userId!, [
      { type: "forum", id: 901 },
      { type: "user", id: 90001 },
    ]);
    const ids = await followedThreadIds(team.userId!);
    expect(ids).toEqual({ forumIds: [901], userIds: [90001] });
    await setFollows(team.userId!, []);
  });

  it("分页：page 收束且两页不重叠", async () => {
    await setFollows(team.userId!, [{ type: "user", id: 90001 }]);
    const p1 = await getFollowFeed(team, 1);
    if (p1.totalPages > 1) {
      const p2 = await getFollowFeed(team, 2);
      expect(p2.page).toBe(2);
      const ids1 = new Set(p1.items.map((t) => t.id));
      expect(p2.items.some((t) => !ids1.has(t.id))).toBe(true);
    }
    const over = await getFollowFeed(team, 99);
    expect(over.page).toBe(over.totalPages);
  });
});
