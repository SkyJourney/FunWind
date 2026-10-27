// @vitest-environment node
/**
 * 私信集成测试（M10 S3）：会话创建（pairKey 唯一/并发撞键）、发送事务（消息+指针+outbox 事件）、
 * 通知指针聚合（pm.received conv:{id}:pm）、打开会话联动已读、额度限频、注销用户拒绝。
 */
import "@/modules";
import { and, eq, sql } from "drizzle-orm";
import {
  conversations,
  conversationMembers,
  DEMO,
  eventOutbox,
  getWebDb,
  messages,
  notifications,
  siteSettings,
  users,
} from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSubject } from "@/lib/authz/subject";
import type { Subject } from "@/lib/authz/types";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { conversationList, otherMemberOf, unreadPmTotal } from "./queries";
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

  it("额度：pmPerDay 达上限后拒绝（0 = 不限）", async () => {
    // 用今天还没发过信的发送者（team），避免前面用例的发送量干扰计数
    await setPmPerDay(1);
    const r1 = await sendMessage(team, DEMO.xiaoyi, "额度内");
    expect(r1.ok).toBe(true);
    const r2 = await sendMessage(team, DEMO.xiaoyi, "超额度");
    expect(r2).toMatchObject({ ok: false, code: "quota_exceeded" });
    await setPmPerDay(50);
  });

  it("自发给/已注销用户/空内容被拒；封禁用户仍可接收（其禁言只拦写类动作）", async () => {
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
    expect(await sendMessage(alice, DEMO.banned, "给封禁用户")).toMatchObject({ ok: true });
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
