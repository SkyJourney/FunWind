// @vitest-environment node
/**
 * M9 通知生产方接线测试：content.submitted（作者回执+版主聚合）、content.moderated（审核结果带理由）、
 * restriction.changed / role.changed（强制通知）、dedupKey 重放幂等。
 */
import "@/modules";
import { and, eq } from "drizzle-orm";
import {
  eventOutbox,
  getWebDb,
  notificationReceipts,
  notifications,
  roleGrants,
} from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { emit } from "@/modules/kernel/bus";
import { ROLE_NOTIFICATION_DELIVERY_POLICY } from "@/modules/kernel/types";
import { dispatchOutboxRows, drainOutbox, enqueueEventInTx } from "@/lib/events/outbox";
import { notify } from "@/lib/notifications/notify";
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
    .onDuplicateKeyUpdate({ set: { scopeId: 904 } });
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

  it("未标记的角色事件保留历史去重，已送但待补派也不重复通知", async () => {
    const payload = {
      userId: 90005,
      roleKey: "demo-team",
      scopeId: 0,
      action: "granted",
      operatorId: 90004,
      expiresAt: null,
    } as const;
    const row = await enqueueEventInTx(db(), "role.changed", payload, { source: "admin" });
    await emit("role.changed", payload, { source: "admin" });
    expect(await drainOutbox()).toMatchObject({ dispatched: 1, failed: 0 });
    expect(await rowsOf(payload.userId, "account.role_changed")).toHaveLength(1);
    expect(
      await db()
        .select()
        .from(notificationReceipts)
        .where(eq(notificationReceipts.outboxId, row.id)),
    ).toHaveLength(0);
  });

  it("已标记角色事件按持久身份去重，不合并再次授予且支持最长角色键", async () => {
    const payload = {
      userId: 90002,
      roleKey: `role-${"a".repeat(59)}`,
      scopeId: 0,
      action: "granted",
      operatorId: 90004,
      expiresAt: "2099-01-01 12:30:00",
    } as const;
    const enqueue = (action: "granted" | "revoked") =>
      enqueueEventInTx(
        db(),
        "role.changed",
        { ...payload, action },
        {
          source: "admin",
          deliveryPolicy: ROLE_NOTIFICATION_DELIVERY_POLICY,
        },
      );
    const first = await enqueue("granted");
    await dispatchOutboxRows([first]);
    expect(await rowsOf(payload.userId, "account.role_changed")).toHaveLength(1);

    // 模拟通知已提交但进程未记派发完成，真实补派仍使用同一出箱身份。
    await db().update(eventOutbox).set({ dispatchedAt: null }).where(eq(eventOutbox.id, first.id));
    expect(await drainOutbox()).toMatchObject({ dispatched: 1, failed: 0 });
    expect(await rowsOf(payload.userId, "account.role_changed")).toHaveLength(1);

    await dispatchOutboxRows([await enqueue("revoked"), await enqueue("granted")]);
    const rows = await rowsOf(payload.userId, "account.role_changed");
    expect(rows).toHaveLength(3);
    expect(
      rows.filter((row) => (row.data as { action: string }).action === "granted"),
    ).toHaveLength(2);
    expect(
      await db()
        .select()
        .from(notificationReceipts)
        .where(eq(notificationReceipts.userId, payload.userId)),
    ).toHaveLength(3);
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
