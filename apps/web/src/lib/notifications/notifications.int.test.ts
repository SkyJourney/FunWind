// @vitest-environment node
/**
 * 通知核心集成测试（M8 S4）：notify 聚合与已读新开、偏好与强制类型、模块停用、
 * 事件 → 通知（经真实模块消费者）、读取契约（unreadSummary/list 合并公告/markRead）。
 */
import { and, eq } from "drizzle-orm";
import {
  announcementReads,
  DEMO,
  getWebDb,
  notificationPreferences,
  notifications,
  siteSettings,
  users,
} from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
// 模块注册表求值：notify 依赖 notificationTypes 声明（与事件消费者同源）
import "@/modules";
import { emit } from "@/modules/kernel/bus";
import { notify } from "./notify";
import { listFeed, markRead, unreadSummary } from "./queries";

let tdb: TempDb;
const db = () => getWebDb();
const ALICE = DEMO.alice;
const TEAM = DEMO.team;

async function unreadOf(userId: number, type: string): Promise<number> {
  const rows = await db().select().from(notifications).where(eq(notifications.userId, userId));
  return rows.filter((r) => r.type === type && r.readAt === null).length;
}

beforeAll(async () => {
  tdb = await setupTempDb();
  const value = {
    titleMax: 100,
    bodyMax: 50000,
    roles: {
      member: { postIntervalSec: 0, threadsPerDay: 0, uploadsPerDay: 20, editWindowSec: 0 },
      admin: { postIntervalSec: 0, threadsPerDay: 0, uploadsPerDay: 0, editWindowSec: 0 },
    },
  };
  await db()
    .insert(siteSettings)
    .values({ key: "limits", value: value as object, updatedAt: sql`NOW()` })
    .onDuplicateKeyUpdate({ set: { value: value as object, updatedAt: sql`NOW()` } });
});

afterAll(async () => {
  await tdb?.teardown();
});

describe.skipIf(skipDb)("notify 管线", () => {
  it("聚合：同 groupKey 未读原位更新（count 递增）；已读后新开", async () => {
    const gk = "post:700001:liked";
    await notify({
      type: "post.liked",
      recipients: [ALICE],
      actorId: TEAM,
      targetType: "post",
      targetId: 700001,
      groupKey: gk,
      data: {},
    });
    await notify({
      type: "post.liked",
      recipients: [ALICE],
      actorId: DEMO.xiaoyi,
      targetType: "post",
      targetId: 700001,
      groupKey: gk,
      data: {},
    });
    const rows = await db().select().from(notifications).where(eq(notifications.userId, ALICE));
    const liked = rows.filter((r) => r.type === "post.liked" && r.groupKey === gk);
    expect(liked).toHaveLength(1); // 聚合成一行
    expect((liked[0].data as { count: number }).count).toBe(2);
    expect(liked[0].readAt).toBeNull();

    // 标记已读后再次点赞 → 新开一行
    await markRead(ALICE, { ids: [liked[0].id] });
    await notify({
      type: "post.liked",
      recipients: [ALICE],
      actorId: TEAM,
      targetType: "post",
      targetId: 700001,
      groupKey: gk,
      data: {},
    });
    const liked2 = (
      await db().select().from(notifications).where(eq(notifications.userId, ALICE))
    ).filter((r) => r.type === "post.liked" && r.groupKey === gk);
    expect(liked2).toHaveLength(2);
    expect(liked2.find((r) => r.readAt !== null)).toBeDefined();
    expect(liked2.find((r) => r.readAt === null)?.id).not.toBe(
      liked2.find((r) => r.readAt !== null)?.id,
    );
    await db().delete(notifications).where(eq(notifications.userId, ALICE));
  });

  it("偏好：非强制类型可关（关后不发）；强制类型短路偏好", async () => {
    // post.liked 可关闭
    await db()
      .insert(notificationPreferences)
      .values({ userId: TEAM, type: "post.liked", channel: "in_app", enabled: false });
    await notify({
      type: "post.liked",
      recipients: [TEAM],
      actorId: ALICE,
      targetType: "post",
      targetId: 1,
      groupKey: "post:1:liked",
      data: {},
    });
    expect(await unreadOf(TEAM, "post.liked")).toBe(0);
    await db().delete(notificationPreferences).where(eq(notificationPreferences.userId, TEAM));

    // security.password_changed 强制：即使写了 disabled 行也发
    await db().insert(notificationPreferences).values({
      userId: TEAM,
      type: "security.password_changed",
      channel: "in_app",
      enabled: false,
    });
    await notify({ type: "security.password_changed", recipients: [TEAM], data: {} });
    expect(await unreadOf(TEAM, "security.password_changed")).toBe(1);
    await db().delete(notificationPreferences).where(eq(notificationPreferences.userId, TEAM));
    await db().delete(notifications).where(eq(notifications.userId, TEAM));
  });

  it("聚合 actorIds 截断到 5（不再无限膨胀）；并发同键聚合恰好一行", async () => {
    const gk = "post:700777:liked";
    // 7 次同键聚合：actorIds 只保留最近 5 个触发者
    for (const actor of [90001, 90002, 90006, 90005, 90003, 90004, 90002]) {
      await notify({
        type: "post.liked",
        recipients: [ALICE],
        actorId: actor,
        targetType: "post",
        targetId: 700777,
        groupKey: gk,
        data: {},
      });
    }
    const rows = (
      await db().select().from(notifications).where(eq(notifications.userId, ALICE))
    ).filter((r) => r.type === "post.liked" && r.groupKey === gk);
    expect(rows).toHaveLength(1);
    const data = rows[0].data as { count: number; actorIds: number[] };
    expect(data.count).toBe(7);
    expect(data.actorIds).toHaveLength(5);
    expect(data.actorIds[0]).toBe(90002); // 最近触发者在前
    await db().delete(notifications).where(eq(notifications.userId, ALICE));

    // 并发 8 路同键：唯一索引 + 重试兜底 → 恰一行，count=8
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        notify({
          type: "post.liked",
          recipients: [ALICE],
          actorId: 90000 + i,
          targetType: "post",
          targetId: 700778,
          groupKey: "post:700778:liked",
          data: {},
        }),
      ),
    );
    const raced = (
      await db().select().from(notifications).where(eq(notifications.userId, ALICE))
    ).filter((r) => r.type === "post.liked" && r.groupKey === "post:700778:liked");
    expect(raced).toHaveLength(1);
    expect((raced[0].data as { count: number }).count).toBe(8);
    await db().delete(notifications).where(eq(notifications.userId, ALICE));
  });

  it("未注册类型抛错（消费失败 → outbox 补派，不静默丢）", async () => {
    await expect(notify({ type: "made.up.type", recipients: [ALICE] })).rejects.toThrow(
      /未注册或停用/,
    );
  });
});

describe.skipIf(skipDb)("事件 → 通知（真实模块消费者）", () => {
  it("thread.replied → 楼主 post.replied + 被回复人 post.reply_to（自己回复自己不发）", async () => {
    await emit(
      "thread.replied",
      {
        threadId: 900001,
        postId: 700010,
        forumId: 901,
        authorId: TEAM,
        threadAuthorId: ALICE,
        replyToPostId: 700011,
        replyToAuthorId: DEMO.xiaoyi,
      },
      { source: "test" },
    );
    expect(await unreadOf(ALICE, "post.replied")).toBe(1);
    expect(await unreadOf(DEMO.xiaoyi, "post.reply_to")).toBe(1);
    // 自回复不通知：author == threadAuthor
    await emit(
      "thread.replied",
      { threadId: 900001, postId: 700012, forumId: 901, authorId: ALICE, threadAuthorId: ALICE },
      { source: "test" },
    );
    expect(
      (await db().select().from(notifications).where(eq(notifications.userId, ALICE))).filter(
        (r) => r.type === "post.replied",
      ).length,
    ).toBe(1);
  });

  it("gate.unlocked → 作者 gate.sold（购买者=作者不发）", async () => {
    await emit(
      "gate.unlocked",
      { gateId: 9001, userId: TEAM, authorId: ALICE, price: 10 },
      { source: "test" },
    );
    expect(await unreadOf(ALICE, "gate.sold")).toBe(1);
    await emit(
      "gate.unlocked",
      { gateId: 9002, userId: ALICE, authorId: ALICE, price: 5 },
      { source: "test" },
    );
    expect(
      (await db().select().from(notifications).where(eq(notifications.userId, ALICE))).filter(
        (r) => r.type === "gate.sold",
      ).length,
    ).toBe(1);
  });

  it("points.changed(adjust.admin) → points.adjusted；earn 渠道不发", async () => {
    await emit(
      "points.changed",
      { userId: TEAM, channel: "adjust.admin", delta: 7 },
      { source: "test" },
    );
    expect(await unreadOf(TEAM, "points.adjusted")).toBe(1);
    await emit(
      "points.changed",
      { userId: TEAM, channel: "earn.post", delta: 3 },
      { source: "test" },
    );
    expect(await unreadOf(TEAM, "points.adjusted")).toBe(1);
  });

  it("gate 购买事件不丢单：快路径失败 → drain 补派 → gate.sold 通知到达（M8-1）", async () => {
    // 用本用例专属的作者（member），不受前序用例给 alice 留下的 gate.sold 影响
    const author = DEMO.member;
    // 直接向 outbox 登记 gate.unlocked（模拟 unlock.ts 事务内登记后快路径失败）
    await getWebDb()
      .execute(sql`INSERT INTO event_outbox (event_name, payload, actor_id, source, created_at)
      VALUES ('gate.unlocked', JSON_OBJECT('gateId', 990001, 'userId', ${TEAM}, 'authorId', ${author}, 'price', 10), ${TEAM}, 'gate', NOW())`);
    // 快路径失败（注入抛错收集器 → 行保持 pending）
    const { drainOutbox } = await import("@/lib/events/outbox");
    await drainOutbox({
      emitter: async (name, payload) => {
        void name;
        void payload;
        throw new Error("注入失败");
      },
    });
    expect(await unreadOf(author, "gate.sold")).toBe(0);
    // 补派成功：默认内核路径（消费者真实跑）→ 通知落地
    await drainOutbox();
    expect(await unreadOf(author, "gate.sold")).toBe(1);
    // 清理：outbox 行与通知，不污染读取契约用例
    await getWebDb().execute(
      sql`DELETE FROM event_outbox WHERE event_name = 'gate.unlocked' AND JSON_EXTRACT(payload, '$.gateId') = 990001`,
    );
    await getWebDb().execute(
      sql`DELETE FROM notifications WHERE user_id = ${author} AND type = 'gate.sold'`,
    );
  });

  it("badge.awarded → 获得徽章通知", async () => {
    await emit("badge.awarded", { userId: TEAM, badgeId: 901 }, { source: "test" });
    expect(await unreadOf(TEAM, "badge.awarded")).toBe(1);
  });
});

describe.skipIf(skipDb)("读取契约", () => {
  it("unreadSummary 分类与公告合并；listFeed 合并时间线 + 游标；markRead 三形态", async () => {
    // 公告（seed 901 audience=all 长期有效）
    const summary1 = await unreadSummary(ALICE);
    expect(summary1.announcement).toBeGreaterThanOrEqual(1);
    expect(summary1.interaction).toBeGreaterThanOrEqual(1); // 前面的用例留下的互动通知

    const feed1 = await listFeed(ALICE);
    expect(feed1.items.length).toBeGreaterThan(0);
    // 合并时间线含公告行
    expect(feed1.items.some((i) => i.kind === "announcement")).toBe(true);
    // 排序 createdAt 降序
    for (let i = 1; i < feed1.items.length; i++) {
      expect(feed1.items[i - 1].createdAt >= feed1.items[i].createdAt).toBe(true);
    }

    // 游标：用第一页末尾的 createdAt 取下一页，不重复
    if (feed1.nextCursor) {
      const feed2 = await listFeed(ALICE, { before: feed1.nextCursor });
      const ids1 = new Set(feed1.items.map((i) => `${i.kind}:${i.id}`));
      for (const item of feed2.items) {
        expect(ids1.has(`${item.kind}:${item.id}`), "游标页不得重复第一页的行").toBe(false);
      }
    }

    // 按分类读取
    const interactionFeed = await listFeed(ALICE, { category: "interaction" });
    expect(interactionFeed.items.every((i) => i.category === "interaction")).toBe(true);

    // markRead ids
    const unreadBefore = (await unreadSummary(ALICE)).total;
    const firstUnread = feed1.items.find((i) => i.kind === "notification" && !i.read);
    if (firstUnread) {
      await markRead(ALICE, { ids: [firstUnread.id] });
      expect((await unreadSummary(ALICE)).total).toBe(unreadBefore - 1);
    }

    // markRead all：全部分类的通知与公告一并清零（E2E 曾抓到 all 只清公告的缺陷）
    await markRead(ALICE, { all: true });
    expect((await unreadSummary(ALICE)).announcement).toBe(0);
    expect((await unreadSummary(ALICE)).total).toBe(0);
  });

  it("通知 actor 已注销时只返回匿名名且不提供 actorId 链接", async () => {
    const groupKey = "m9.6-deleted-notification-actor";
    await db().update(users).set({ state: "deleted" }).where(eq(users.id, DEMO.xiaoyi));
    try {
      await notify({
        type: "post.replied",
        recipients: [ALICE],
        actorId: DEMO.xiaoyi,
        targetType: "post",
        targetId: 900101,
        groupKey,
        data: { title: "匿名身份回归" },
      });
      const feed = await listFeed(ALICE);
      const item = feed.items.find(
        (entry) => entry.kind === "notification" && entry.groupKey === groupKey,
      );
      expect(item).toMatchObject({ actorId: null, actorName: "已注销用户" });
    } finally {
      await db().update(users).set({ state: "active" }).where(eq(users.id, DEMO.xiaoyi));
      await db()
        .delete(notifications)
        .where(and(eq(notifications.userId, ALICE), eq(notifications.groupKey, groupKey)));
    }
  });

  it("游客：只有 audience=all 的公告，total=公告数", async () => {
    const s = await unreadSummary(null);
    expect(s.interaction).toBe(0);
    expect(s.announcement).toBeGreaterThanOrEqual(1);
    const feed = await listFeed(null);
    expect(feed.items.every((i) => i.kind === "announcement")).toBe(true);
  });

  it("markRead 公告：写 announcement_reads 且幂等", async () => {
    await markRead(TEAM, { category: "announcement" });
    const rows1 = await db()
      .select()
      .from(announcementReads)
      .where(eq(announcementReads.userId, TEAM));
    expect(rows1.length).toBeGreaterThanOrEqual(1);
    await markRead(TEAM, { category: "announcement" });
    const rows2 = await db()
      .select()
      .from(announcementReads)
      .where(eq(announcementReads.userId, TEAM));
    expect(rows2.length).toBe(rows1.length);
    expect((await unreadSummary(TEAM)).announcement).toBe(0);
  });
});
