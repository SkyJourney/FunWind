// @vitest-environment node
/**
 * 私信集成测试（M10 S3）：会话创建（pairKey 唯一/并发撞键）、发送事务（消息+指针+outbox 事件）、
 * 通知指针聚合（pm.received conv:{id}:pm）、打开会话联动已读、额度限频、注销用户拒绝。
 */
import "@/modules";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  accountDeletionRequests,
  conversations,
  conversationMembers,
  DEMO,
  eventOutbox,
  eventLog,
  follows,
  getWebDb,
  messages,
  notifications,
  siteSettings,
  userProfiles,
  userRestrictions,
  users,
} from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as outbox from "@/lib/events/outbox";
import * as dbPackage from "@funwind/db";
import { loadSubject } from "@/lib/authz/subject";
import type { Subject } from "@/lib/authz/types";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import {
  conversationList,
  messagesBefore,
  otherMemberOf,
  otherMemberSummaryOf,
  unreadPmTotal,
} from "./queries";
import { openConversation, sendMessage } from "./service";

let tdb: TempDb;
let alice: Subject;
let team: Subject;
const db = () => getWebDb();

/** 放开私信额度（默认 member 50/日） */
async function setPmPerDay(n: number) {
  const value = {
    titleMax: 100,
    bodyMax: 50000,
    roles: {
      member: {
        postIntervalSec: 0,
        threadsPerDay: 0,
        uploadsPerDay: 20,
        editWindowSec: 0,
        pmPerDay: n,
      },
      admin: {
        postIntervalSec: 0,
        threadsPerDay: 0,
        uploadsPerDay: 0,
        editWindowSec: 0,
        pmPerDay: 0,
      },
    },
  };
  await db()
    .insert(siteSettings)
    .values({ key: "limits", value: value as object, updatedAt: sql`NOW()` })
    .onDuplicateKeyUpdate({ set: { value: value as object, updatedAt: sql`NOW()` } });
}

beforeAll(async () => {
  tdb = await setupTempDb();
  alice = await loadSubject(DEMO.alice);
  team = await loadSubject(DEMO.team);
  await setPmPerDay(50);
});

afterAll(async () => {
  await tdb?.teardown();
});

describe.skipIf(skipDb)("私信（M10）", () => {
  it("发送：建会话 + 双方成员 + 消息 + message.sent 入 outbox（已派发）", async () => {
    const r = await sendMessage(alice, DEMO.team, "第一条私信");
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const [conv] = await db()
      .select()
      .from(conversations)
      .where(eq(conversations.id, r.conversationId));
    expect(conv.pairKey).toBe(
      `${Math.min(DEMO.alice, DEMO.team)}:${Math.max(DEMO.alice, DEMO.team)}`,
    );
    const members = await db()
      .select()
      .from(conversationMembers)
      .where(eq(conversationMembers.conversationId, r.conversationId));
    expect(members).toHaveLength(2);
    const msgs = await db()
      .select()
      .from(messages)
      .where(eq(messages.conversationId, r.conversationId));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].body).toBe("第一条私信");

    const [ev] = await db()
      .select()
      .from(eventOutbox)
      .where(eq(eventOutbox.eventName, "message.sent"));
    expect(ev.dispatchedAt).not.toBeNull();
  });

  it("通知指针：收信人得到 pm.received（conv:{id}:pm 聚合，count 递增）", async () => {
    const r = await sendMessage(alice, DEMO.team, "第二条私信");
    if (!r.ok) throw new Error(r.code);
    const rows = await db()
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, DEMO.team), eq(notifications.type, "pm.received")));
    expect(rows).toHaveLength(1); // 聚合一行
    expect(rows[0].groupKey).toBe(`conv:${r.conversationId}:pm`);
    const data = rows[0].data as { count: number };
    expect(data.count).toBeGreaterThanOrEqual(2);
  });

  it("打开会话：指针推进 + 该会话未读通知行清零；未读数归零", async () => {
    const list = await conversationList(DEMO.team);
    const conv = list.find((c) => c.otherId === DEMO.alice);
    expect(conv).toBeDefined();
    expect(conv!.unread).toBeGreaterThan(0);

    expect(await openConversation(DEMO.team, conv!.conversationId)).toBe(true);
    const after = await conversationList(DEMO.team);
    expect(after.find((c) => c.conversationId === conv!.conversationId)?.unread).toBe(0);
    const rows = await db()
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, DEMO.team), eq(notifications.type, "pm.received")));
    expect(rows.every((r) => r.readAt !== null)).toBe(true);
  });

  it("非成员不能打开会话", async () => {
    const list = await conversationList(DEMO.team);
    const conv = list.find((c) => c.otherId === DEMO.alice);
    expect(conv).toBeDefined();
    expect(await openConversation(DEMO.member, conv!.conversationId)).toBe(false);
  });

  it("并发额度：同一发送者同时发给不同收件人时只放行一条", async () => {
    const sender = await loadSubject(DEMO.xiaoyi);
    const bodyA = `pm-quota-race-a-${Date.now()}`;
    const bodyB = `pm-quota-race-b-${Date.now()}`;
    await setPmPerDay(1);
    try {
      const results = await Promise.all([
        sendMessage(sender, DEMO.member, bodyA),
        sendMessage(sender, DEMO.admin, bodyB),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.find((result) => !result.ok)).toMatchObject({
        ok: false,
        code: "quota_exceeded",
      });
      const stored = await db()
        .select({ body: messages.body })
        .from(messages)
        .where(and(eq(messages.senderId, DEMO.xiaoyi), inArray(messages.body, [bodyA, bodyB])));
      expect(stored).toHaveLength(1);
    } finally {
      await setPmPerDay(50);
    }
  });

  it("额度：pmPerDay 达上限后拒绝（0 = 不限）", async () => {
    // 用今天还没发过信的发送者（team），避免前面用例的发送量干扰计数
    await setPmPerDay(1);
    const r1 = await sendMessage(team, DEMO.xiaoyi, "额度内");
    expect(r1.ok).toBe(true);
    const r2 = await sendMessage(team, DEMO.xiaoyi, "超额度");
    expect(r2).toMatchObject({ ok: false, code: "quota_exceeded" });
    await setPmPerDay(50);
  });

  it("自发给/已注销用户/封禁用户/空内容均被拒", async () => {
    expect(await sendMessage(alice, DEMO.alice, "自己")).toMatchObject({ ok: false, code: "self" });
    // 已注销（state=deleted）占位行：不可作为收信人
    await db()
      .insert(users)
      .values({
        id: 99999998,
        username: "deleted_placeholder",
        usernameKey: "deleted_placeholder",
        email: null,
        emailKey: null,
        passwordHash: null,
        state: "deleted",
        createdAt: "2026-01-01 00:00:00",
      })
      .onDuplicateKeyUpdate({ set: { state: "deleted" } });
    expect(await sendMessage(alice, 99999998, "给注销用户")).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(await sendMessage(alice, DEMO.banned, "给封禁用户")).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(await sendMessage(alice, DEMO.team, "   ")).toMatchObject({
      ok: false,
      code: "reason_required",
    });
    // 超长内容被拒
    expect(await sendMessage(alice, DEMO.team, "x".repeat(5001))).toMatchObject({
      ok: false,
      code: "reason_required",
    });
  });

  it("并发首信：pairKey 唯一键兜底，只有一个会话", async () => {
    const [r1, r2] = await Promise.all([
      sendMessage(alice, DEMO.xiaoyi, "并发 A"),
      sendMessage(alice, DEMO.xiaoyi, "并发 B"),
    ]);
    expect(r1.ok && r2.ok).toBe(true);
    const convs = await db()
      .select()
      .from(conversations)
      .where(eq(conversations.pairKey, `${DEMO.alice}:${DEMO.xiaoyi}`));
    expect(convs).toHaveLength(1);
    const members = await db()
      .select()
      .from(conversationMembers)
      .where(eq(conversationMembers.conversationId, convs[0].id));
    expect(members).toHaveLength(2);
  });

  it("会话列表：对方缺失时的兜底 + 无未读时计数 0", async () => {
    // 造一个只有自己成员的会话（对方成员行缺失）→ otherId 0、名字 null
    const [convRow] = (await db()
      .insert(conversations)
      .values({ pairKey: "1:1", createdAt: "2026-10-26 10:00:00" })) as unknown as [
      { insertId: number },
    ];
    const convId = Number(convRow.insertId);
    await db().insert(conversationMembers).values({ conversationId: convId, userId: DEMO.alice });
    const list = await conversationList(DEMO.alice);
    const lonely = list.find((c) => c.conversationId === convId);
    expect(lonely).toBeDefined();
    expect(lonely!.otherId).toBe(0);
    expect(lonely!.otherName).toBeNull();
    expect(lonely!.unread).toBe(0);
    expect(await otherMemberOf(convId, DEMO.alice)).toBeNull();
  });

  it("openConversation 对空会话（无消息）安全：指针不推进、返回 true", async () => {
    const [convRow] = (await db()
      .insert(conversations)
      .values({ pairKey: "2:3", createdAt: "2026-10-26 10:00:00" })) as unknown as [
      { insertId: number },
    ];
    const convId = Number(convRow.insertId);
    await db()
      .insert(conversationMembers)
      .values([
        { conversationId: convId, userId: DEMO.alice },
        { conversationId: convId, userId: DEMO.team },
      ]);
    expect(await openConversation(DEMO.alice, convId)).toBe(true);
    const [member] = await db()
      .select()
      .from(conversationMembers)
      .where(eq(conversationMembers.conversationId, convId));
    expect(member.lastReadMessageId ?? null).toBeNull();
  });

  it("会话列表：对方信息与未读数正确（不依赖排序——前面用例产生的会话顺序不定）", async () => {
    const list = await conversationList(DEMO.team);
    expect(list.length).toBeGreaterThan(0);
    // team 的每个会话的对方都应是 alice（90001）——前面用例与 alice/xiaoyi 都有过对话，
    // 这里只断言「所有对方的并集覆盖 alice」且不含 team 自己
    const others = new Set(list.map((c) => c.otherId));
    expect(others.has(DEMO.alice)).toBe(true);
    expect(others.has(DEMO.team)).toBe(false);
  });

  it("私信权限（M10.5）：策略只拦「新会话首信」，已有会话的回复不受影响", async () => {
    // 用一个与 alice 尚无会话的账号，保证「新会话」路径
    const fresh = DEMO.member;
    await db()
      .delete(conversations)
      .where(
        eq(conversations.pairKey, `${Math.min(DEMO.alice, fresh)}:${Math.max(DEMO.alice, fresh)}`),
      );
    await db()
      .insert(userProfiles)
      .values({ userId: fresh, pmPolicy: "off" })
      .onDuplicateKeyUpdate({ set: { pmPolicy: "off" } });
    // off：拒绝新会话首信
    expect(await sendMessage(alice, fresh, "off 拒收新会话")).toMatchObject({
      ok: false,
      code: "pm_off",
    });

    // following：对方未关注发送方 → 拒绝新会话首信
    await db()
      .update(userProfiles)
      .set({ pmPolicy: "following" })
      .where(eq(userProfiles.userId, fresh));
    expect(await sendMessage(alice, fresh, "非关注者首信")).toMatchObject({
      ok: false,
      code: "pm_following",
    });
    // 对方关注 alice 后放行（follows 造行，幂等清理）
    await db()
      .insert(follows)
      .values({
        userId: fresh,
        targetType: "user",
        targetId: DEMO.alice,
        createdAt: sql`NOW()`,
      });
    expect(await sendMessage(alice, fresh, "关注者可发首信")).toMatchObject({ ok: true });
    await db()
      .delete(follows)
      .where(and(eq(follows.userId, fresh), eq(follows.targetId, DEMO.alice)));

    // **已有会话的回复不受策略影响**：改成 off 后旧会话仍可继续聊
    await db().update(userProfiles).set({ pmPolicy: "off" }).where(eq(userProfiles.userId, fresh));
    expect(await sendMessage(alice, fresh, "旧会话回复应放行")).toMatchObject({ ok: true });

    await db().update(userProfiles).set({ pmPolicy: "all" }).where(eq(userProfiles.userId, fresh));

    const reason = "m9.6-pm-ban-read-only";
    await db()
      .insert(userRestrictions)
      .values({
        userId: fresh,
        kind: "ban",
        scopeId: 0,
        reason,
        startsAt: sql`NOW()`,
        endsAt: null,
        createdBy: DEMO.admin,
        createdAt: sql`NOW()`,
      });
    try {
      expect(await sendMessage(alice, fresh, "封禁期间旧会话只读")).toMatchObject({
        ok: false,
        code: "not_found",
      });
    } finally {
      await db()
        .delete(userRestrictions)
        .where(and(eq(userRestrictions.userId, fresh), eq(userRestrictions.reason, reason)));
    }

    const [closure] = (await db()
      .insert(accountDeletionRequests)
      .values({
        userId: fresh,
        status: "pending",
        requestedAt: sql`NOW()`,
        scheduledAt: sql`NOW() + INTERVAL 30 DAY`,
      })) as unknown as [{ insertId: number }];
    try {
      expect(await sendMessage(alice, fresh, "注销申请期不能收新私信")).toMatchObject({
        ok: false,
        code: "not_found",
      });
    } finally {
      await db()
        .delete(accountDeletionRequests)
        .where(eq(accountDeletionRequests.id, Number(closure.insertId)));
    }
  });

  it.each(["pending", "completed"] as const)(
    "旧 Subject 的发送者已有 %s 注销申请时拒绝私信且不落消息/事件",
    async (status) => {
      const sender = await loadSubject(DEMO.member);
      const beforeMessages = await db().select().from(messages);
      const beforeConversations = await db().select().from(conversations);
      const beforeMembers = await db().select().from(conversationMembers);
      const beforeEvents = await db().select().from(eventOutbox);
      const beforeNotifications = await db().select().from(notifications);
      await db()
        .insert(accountDeletionRequests)
        .values({
          userId: DEMO.member,
          status,
          requestedAt: sql`NOW()`,
          scheduledAt: sql`NOW() + INTERVAL 30 DAY`,
        });
      try {
        expect(await sendMessage(sender, DEMO.admin, `注销发送者-${status}`)).toMatchObject({
          ok: false,
          code: "forbidden",
        });
        expect(await db().select().from(messages)).toEqual(beforeMessages);
        expect(await db().select().from(conversations)).toEqual(beforeConversations);
        expect(await db().select().from(conversationMembers)).toEqual(beforeMembers);
        expect(await db().select().from(eventOutbox)).toEqual(beforeEvents);
        expect(await db().select().from(notifications)).toEqual(beforeNotifications);
      } finally {
        await db()
          .delete(accountDeletionRequests)
          .where(eq(accountDeletionRequests.userId, DEMO.member));
      }
    },
  );

  it("注销先持发送者锁：发送等待提交后须重新检查注销申请，不产生私信副作用", async () => {
    const sender = await loadSubject(DEMO.member);
    const runtimeDb = db();
    const originalTransaction = runtimeDb.transaction.bind(runtimeDb);
    const beforeMessages = await db().select().from(messages);
    const beforeEvents = await db().select().from(eventOutbox);
    const beforeConversations = await db().select().from(conversations);
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const closure = originalTransaction(async (tx) => {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, DEMO.member)).for("update");
      await tx.insert(accountDeletionRequests).values({
        userId: DEMO.member,
        status: "pending",
        requestedAt: sql`NOW()`,
        scheduledAt: sql`NOW() + INTERVAL 30 DAY`,
      });
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    vi.spyOn(dbPackage, "getWebDb").mockReturnValue(runtimeDb);
    const entered = Promise.withResolvers<void>();
    vi.spyOn(runtimeDb, "transaction").mockImplementation((fn, options) => {
      entered.resolve();
      return originalTransaction(fn, options);
    });
    const sending = sendMessage(sender, DEMO.admin, "等待注销提交后不能发信");
    try {
      await entered.promise;
      release.resolve();
      await closure;
      expect(await sending).toMatchObject({ ok: false, code: "forbidden" });
      expect(await db().select().from(messages)).toEqual(beforeMessages);
      expect(await db().select().from(eventOutbox)).toEqual(beforeEvents);
      expect(await db().select().from(conversations)).toEqual(beforeConversations);
    } finally {
      release.resolve();
      await Promise.allSettled([closure, sending]);
      vi.restoreAllMocks();
      await db()
        .delete(accountDeletionRequests)
        .where(eq(accountDeletionRequests.userId, DEMO.member));
    }
  });

  it("全站禁言不影响无版块上下文的私信", async () => {
    const reason = "m9.6-pm-global-mute";
    await db()
      .insert(userRestrictions)
      .values({
        userId: DEMO.alice,
        kind: "mute",
        scopeId: 0,
        reason,
        startsAt: sql`NOW()`,
        endsAt: null,
        createdBy: DEMO.admin,
        createdAt: sql`NOW()`,
      });
    try {
      const mutedAlice = await loadSubject(DEMO.alice);
      expect(await sendMessage(mutedAlice, DEMO.xiaoyi, "全站禁言仍可发私信")).toMatchObject({
        ok: true,
      });
    } finally {
      await db()
        .delete(userRestrictions)
        .where(and(eq(userRestrictions.userId, DEMO.alice), eq(userRestrictions.reason, reason)));
    }
  });

  it("注销对端在会话列表与历史中只投影匿名身份", async () => {
    const xiaoyi = await loadSubject(DEMO.xiaoyi);
    const first = await sendMessage(alice, DEMO.xiaoyi, "匿名历史会话");
    if (!first.ok) throw new Error(first.code);
    await sendMessage(xiaoyi, DEMO.alice, "对方历史消息");
    await db().update(users).set({ state: "deleted" }).where(eq(users.id, DEMO.xiaoyi));
    try {
      const item = (await conversationList(DEMO.alice)).find(
        (conversation) => conversation.conversationId === first.conversationId,
      );
      expect(item).toMatchObject({
        otherId: null,
        otherName: "已注销用户",
        otherDeleted: true,
      });
      expect(await otherMemberSummaryOf(first.conversationId, DEMO.alice)).toEqual({
        userId: null,
        displayName: "已注销用户",
        deleted: true,
      });
      const history = await messagesBefore(first.conversationId, null);
      expect(history.items.find((message) => message.body === "对方历史消息")?.senderId).toBeNull();

      await db().update(users).set({ state: "active" }).where(eq(users.id, DEMO.xiaoyi));
      await db()
        .insert(accountDeletionRequests)
        .values({
          userId: DEMO.xiaoyi,
          status: "completed",
          requestedAt: sql`NOW()`,
          scheduledAt: sql`NOW()`,
          completedAt: sql`NOW()`,
        });
      const tombstoneItem = (await conversationList(DEMO.alice)).find(
        (conversation) => conversation.conversationId === first.conversationId,
      );
      expect(tombstoneItem).toMatchObject({ otherId: null, otherName: "已注销用户" });
      const tombstoneHistory = await messagesBefore(first.conversationId, null);
      expect(
        tombstoneHistory.items.find((message) => message.body === "对方历史消息")?.senderId,
      ).toBeNull();
    } finally {
      await db()
        .delete(accountDeletionRequests)
        .where(
          and(
            eq(accountDeletionRequests.userId, DEMO.xiaoyi),
            eq(accountDeletionRequests.status, "completed"),
          ),
        );
      await db().update(users).set({ state: "active" }).where(eq(users.id, DEMO.xiaoyi));
    }
  });

  it("积压超过巡检批次时本条私信优先派发，事件沿用 pm 来源且只通知一次", async () => {
    const backlog = await db().transaction(async (tx) => {
      const rows = [];
      for (let i = 0; i < 12; i++) {
        rows.push(
          await outbox.enqueueEventInTx(
            tx,
            "user.followed",
            { userId: DEMO.alice, targetType: "forum", targetId: 901 },
            { actorId: DEMO.alice, source: "backlog" },
          ),
        );
      }
      return rows;
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await sendMessage(alice, DEMO.team, "积压下本条私信应立即送达");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const [current] = await db()
        .select()
        .from(eventOutbox)
        .where(eq(eventOutbox.eventName, "message.sent"))
        .orderBy(sql`${eventOutbox.id} DESC`)
        .limit(1);
      expect(current.id).toBeGreaterThan(backlog.at(-1)!.id);
      expect(current.dispatchedAt).not.toBeNull();
      const older = await db()
        .select()
        .from(eventOutbox)
        .where(
          inArray(
            eventOutbox.id,
            backlog.map((row) => row.id),
          ),
        );
      expect(older.filter((row) => row.dispatchedAt !== null)).toHaveLength(10);
      const logs = await db().select().from(eventLog).where(eq(eventLog.eventName, "message.sent"));
      const currentLogs = logs.filter(
        (row) => JSON.stringify(row.payload) === JSON.stringify(current.payload),
      );
      expect(currentLogs).toHaveLength(1);
      expect(currentLogs[0]).toMatchObject({ source: "pm", actorId: DEMO.alice });
      const notices = await db()
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, DEMO.team),
            eq(notifications.groupKey, `conv:${result.conversationId}:pm`),
          ),
        );
      const data = structuredClone(notices.at(-1)!.data);
      await outbox.sweepPending();
      const after = await db()
        .select()
        .from(notifications)
        .where(eq(notifications.id, notices.at(-1)!.id));
      expect(after[0].data).toEqual(data);
    } finally {
      warning.mockRestore();
      await db()
        .delete(eventOutbox)
        .where(
          inArray(
            eventOutbox.id,
            backlog.map((row) => row.id),
          ),
        );
    }
  });

  it("入队后死锁回滚并重试，只派发最终提交的事件行", async () => {
    const enqueue = outbox.enqueueEventInTx;
    let rolledBackId = 0;
    const injected = vi
      .spyOn(outbox, "enqueueEventInTx")
      .mockImplementationOnce(async (...args) => {
        rolledBackId = (await enqueue(...args)).id;
        throw Object.assign(new Error("测试模拟死锁"), { code: "ER_LOCK_DEADLOCK" });
      });
    const dispatch = vi.spyOn(outbox, "dispatchOutboxRows");
    const body = "死锁重试不派发回滚事件";
    try {
      const result = await sendMessage(alice, DEMO.team, body);
      expect(result.ok).toBe(true);
      expect(injected).toHaveBeenCalledTimes(2);
      const storedMessages = await db().select().from(messages).where(eq(messages.body, body));
      expect(storedMessages).toHaveLength(1);
      expect(
        await db().select().from(eventOutbox).where(eq(eventOutbox.id, rolledBackId)),
      ).toHaveLength(0);
      expect(dispatch).toHaveBeenCalledOnce();
      const dispatchedRows = dispatch.mock.calls[0]![0];
      expect(dispatchedRows).toHaveLength(1);
      expect(dispatchedRows[0].id).not.toBe(rolledBackId);
      expect(dispatchedRows[0].payload).toMatchObject({ messageId: storedMessages[0].id });
      const [storedEvent] = await db()
        .select()
        .from(eventOutbox)
        .where(eq(eventOutbox.id, dispatchedRows[0].id));
      expect(storedEvent.dispatchedAt).not.toBeNull();
    } finally {
      injected.mockRestore();
      dispatch.mockRestore();
    }
  });

  it("私信事务入队后失败时消息与事件一起回滚，不触发快路径", async () => {
    const enqueue = outbox.enqueueEventInTx;
    let rolledBackId = 0;
    const failure = new Error("私信入队后失败");
    const injected = vi
      .spyOn(outbox, "enqueueEventInTx")
      .mockImplementationOnce(async (...args) => {
        rolledBackId = (await enqueue(...args)).id;
        throw failure;
      });
    const dispatch = vi.spyOn(outbox, "dispatchOutboxRows");
    const body = "回滚私信不得派发";
    try {
      await expect(sendMessage(alice, DEMO.team, body)).rejects.toBe(failure);
      expect(await db().select().from(messages).where(eq(messages.body, body))).toHaveLength(0);
      expect(
        await db().select().from(eventOutbox).where(eq(eventOutbox.id, rolledBackId)),
      ).toHaveLength(0);
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      injected.mockRestore();
      dispatch.mockRestore();
    }
  });

  it("unreadPmTotal：角标总数与会话列表未读之和一致，打开会话后清零", async () => {
    const r = await sendMessage(alice, DEMO.team, "角标用私信");
    if (!r.ok) throw new Error(r.code);
    const list = await conversationList(DEMO.team);
    const sum = list.reduce((acc, c) => acc + c.unread, 0);
    expect(await unreadPmTotal(DEMO.team)).toBe(sum);
    expect(sum).toBeGreaterThan(0);

    const conv = list.find((c) => c.conversationId === r.conversationId)!;
    expect(await openConversation(DEMO.team, conv.conversationId)).toBe(true);
    const after = await conversationList(DEMO.team);
    expect(await unreadPmTotal(DEMO.team)).toBe(after.reduce((acc, c) => acc + c.unread, 0));
  });
});
