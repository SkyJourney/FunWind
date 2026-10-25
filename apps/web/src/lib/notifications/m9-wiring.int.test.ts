// @vitest-environment node
/**
 * M9 通知生产方接线测试：content.submitted（作者回执+版主聚合）、content.moderated（审核结果带理由）、
 * restriction.changed / role.changed（强制通知）、dedupKey 重放幂等。
 */
import "@/modules";
import { and, eq } from "drizzle-orm";
import { getWebDb, notifications } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { emit } from "@/modules/kernel/bus";
import { notify } from "@/lib/notifications/notify";
import { roleGrants } from "@funwind/db";
import { invalidateAuthzSnapshot } from "@/lib/authz/snapshot";

let tdb: TempDb;
const db = () => getWebDb();

async function rowsOf(userId: number, type: string) {
  return db()
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.type, type)));
}

beforeAll(async () => {
  tdb = await setupTempDb();
  // seed 没有「真版主」（admin 被 getForumModerators 有意排除）——给 demo-team 补 904 的 forum.moderate
  await getWebDb()
    .insert(roleGrants)
    .values({ roleKey: "demo-team", permissionKey: "forum.moderate", scopeId: 904 })
    .onDuplicateKeyUpdate({ set: { roleKey: roleGrants.roleKey } });
  invalidateAuthzSnapshot();
});

afterAll(async () => {
  await tdb?.teardown();
});

describe.skipIf(skipDb)("M9 通知生产方", () => {
  it("content.submitted：作者回执 + 版主聚合 review.pending（count 合并）", async () => {
    await emit(
      "content.submitted",
      { postId: 800101, threadId: 800101, authorId: 90005, forumId: 904, isThread: true },
      { source: "test" },
    );
    // 作者回执
    expect((await rowsOf(90005, "content.submitted")).length).toBe(1);
    // 904 的版主 = demo-team（getForumModerators 有意排除 admin 的基线授权）——review.pending 聚合行
    const pend = await rowsOf(90006, "review.pending");
    expect(pend.length).toBeGreaterThanOrEqual(1);
    const row = pend.find((r) => r.groupKey === "forum:904:review_pending");
    expect(row).toBeDefined();
    const count1 = (row!.data as { count: number }).count;
    expect(count1).toBeGreaterThanOrEqual(1);

    // 第二条待审 → count 递增
    await emit(
      "content.submitted",
      { postId: 800102, threadId: 800102, authorId: 90005, forumId: 904, isThread: true },
      { source: "test" },
    );
    const row2 = (await rowsOf(90006, "review.pending")).find(
      (r) => r.groupKey === "forum:904:review_pending",
    );
    expect((row2!.data as { count: number }).count).toBe(count1 + 1);
  });

  it("content.moderated：reject → 作者 content.rejected（reason 入 data）", async () => {
    await emit(
      "content.moderated",
      { postId: 900107, operatorId: 90004, action: "reject", reason: "与版块主题无关" },
      { source: "test" },
    );
    const rows = await rowsOf(90002, "content.rejected");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect((rows[rows.length - 1].data as { reason?: string }).reason).toBe("与版块主题无关");
  });

  it("restriction.changed：created → account.restricted（强制、带 kind/理由）", async () => {
    await emit(
      "restriction.changed",
      {
        userId: 90005,
        kind: "mute",
        action: "created",
        operatorId: 90004,
        reason: "灌水",
        endsAt: null,
      },
      { source: "test" },
    );
    const rows = await rowsOf(90005, "account.restricted");
    expect(rows.length).toBe(1);
    expect((rows[0].data as { reason: string }).reason).toBe("灌水");
  });

  it("role.changed：granted → account.role_changed", async () => {
    await emit(
      "role.changed",
      { userId: 90005, roleKey: "demo-team", scopeId: 0, action: "granted", operatorId: 90004 },
      { source: "test" },
    );
    expect((await rowsOf(90005, "account.role_changed")).length).toBe(1);
  });

  it("dedupKey：同一键重放只入一行（at-least-once 幂等）", async () => {
    const input = {
      type: "content.approved",
      recipients: [90006],
      actorId: 90004,
      targetType: "post",
      targetId: 800999,
      dedupKey: (uid: number) => `mod:800999:approve:${uid}`,
      data: {},
    } as const;
    await notify(input);
    await notify(input); // 重放
    await notify(input); // 再重放
    expect((await rowsOf(90006, "content.approved")).length).toBe(1);
  });
});
