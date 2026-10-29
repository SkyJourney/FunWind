// @vitest-environment node
/**
 * M10 补做集成测试：管理侧（投票关闭/删除、私信删消息）与私信消息分页（夹具造 100 条消息跨 4 页）。
 */
import { and, eq, sql } from "drizzle-orm";
import {
  auditLog,
  conversations,
  conversationMembers,
  DEMO,
  getWebDb,
  messages,
  polls,
  pollOptions,
  pollVotes,
  siteSettings,
  threads,
} from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSubject } from "@/lib/authz/subject";
import type { Subject } from "@/lib/authz/types";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { closePoll, deletePoll, listPollPage } from "@/lib/poll/admin";
import { deleteMessage } from "@/lib/pm/admin";
import { conversationMessages, sendMessage } from "@/lib/pm/service";

let tdb: TempDb;
let admin: Subject;
const db = () => getWebDb();
const ACTOR = { userId: DEMO.admin, via: "admin" as const, ip: null };

beforeAll(async () => {
  tdb = await setupTempDb();
  admin = await loadSubject(DEMO.admin);
  const value = {
    titleMax: 100,
    bodyMax: 50000,
    roles: {
      member: {
        postIntervalSec: 0,
        threadsPerDay: 0,
        uploadsPerDay: 20,
        editWindowSec: 0,
        pmPerDay: 0,
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
});

afterAll(async () => {
  await tdb?.teardown();
});

/** 直插一个投票（免走 createThread 的频控） */
async function seedPoll(): Promise<{ pollId: number; threadId: number; optionIds: number[] }> {
  const [t] = (await db()
    .insert(threads)
    .values({
      forumId: 901,
      authorId: DEMO.alice,
      title: `管理测试投票 ${Date.now()}-${Math.random()}`,
      kind: "poll",
      state: "visible",
      createdAt: "2026-10-26 00:00:00",
      lastPostedAt: "2026-10-26 00:00:00",
    })) as unknown as [{ insertId: number }];
  const threadId = Number(t.insertId);
  const [p] = (await db().insert(polls).values({
    threadId,
    optionLimit: 1,
    endsAt: null,
    resultVisibility: "always",
    voterCount: 0,
    createdBy: DEMO.alice,
    createdAt: "2026-10-26 00:00:00",
  })) as unknown as [{ insertId: number }];
  const pollId = Number(p.insertId);
  await db()
    .insert(pollOptions)
    .values([
      { pollId, content: "选项一", voteCount: 0, sortOrder: 0 },
      { pollId, content: "选项二", voteCount: 0, sortOrder: 1 },
    ]);
  // 回查真实 id
  const rows = await db()
    .select({ id: pollOptions.id })
    .from(pollOptions)
    .where(eq(pollOptions.pollId, pollId))
    .orderBy(pollOptions.sortOrder);
  return { pollId, threadId, optionIds: rows.map((r) => r.id) };
}

describe.skipIf(skipDb)("投票管理（M10 补做）", () => {
  it("列表：全站视角可见；关闭投票（ends_at 置当前 + 审计）", async () => {
    const { pollId } = await seedPoll();
    const list = (await listPollPage({ status: "all", page: 1, moderated: null })).items;
    expect(list.some((p) => p.pollId === pollId)).toBe(true);

    await closePoll(ACTOR, pollId);
    const [poll] = await db().select().from(polls).where(eq(polls.id, pollId));
    expect(poll.endsAt).not.toBeNull();
    const [audit] = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "poll.close"), eq(auditLog.targetId, String(pollId))));
    expect(audit).toBeDefined();

    // 已截止：再关闭 → already（AdminError）
    await expect(closePoll(ACTOR, pollId)).rejects.toMatchObject({ message: "该投票已截止" });
  });

  it("删除投票：三表明细清空、主题 kind 回 normal、审计；列表不再含", async () => {
    const { pollId, threadId, optionIds } = await seedPoll();
    await db().insert(pollVotes).values({
      pollId,
      optionId: optionIds[0]!,
      userId: DEMO.team,
      createdAt: "2026-10-26 00:00:00",
    });

    await deletePoll(ACTOR, pollId);
    expect((await db().select().from(polls).where(eq(polls.id, pollId))).length).toBe(0);
    expect(
      (await db().select().from(pollOptions).where(eq(pollOptions.pollId, pollId))).length,
    ).toBe(0);
    expect((await db().select().from(pollVotes).where(eq(pollVotes.pollId, pollId))).length).toBe(
      0,
    );
    const [t] = await db()
      .select({ kind: threads.kind })
      .from(threads)
      .where(eq(threads.id, threadId));
    expect(t.kind).toBe("normal");
    const [audit] = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "poll.delete"), eq(auditLog.targetId, String(pollId))));
    expect(audit).toBeDefined();
    expect(
      (await listPollPage({ status: "all", page: 1, moderated: null })).items.some(
        (p) => p.pollId === pollId,
      ),
    ).toBe(false);
  });
});

describe.skipIf(skipDb)("私信管理（M10 补做）", () => {
  it("删除违规消息：正文标记 + 审计；消息序号保留", async () => {
    const r = await sendMessage(admin, DEMO.team, "违规消息内容");
    if (!r.ok) throw new Error(r.code);
    const [msg] = await db()
      .select()
      .from(messages)
      .where(eq(messages.conversationId, r.conversationId));
    await deleteMessage(ACTOR, msg.id, "违规");
    const [after] = await db().select().from(messages).where(eq(messages.id, msg.id));
    expect(after.body).toContain("已由管理员删除");
    const [audit] = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "pm.message.delete"), eq(auditLog.targetId, String(msg.id))));
    expect(audit).toBeDefined();
    // 空理由被拒
    await expect(deleteMessage(ACTOR, msg.id, "  ")).rejects.toMatchObject({
      message: "必须填写删除理由",
    });
  });
});

describe.skipIf(skipDb)("私信消息分页（夹具 100 条）", () => {
  it("100 条消息分 4 页（30/页）：页序正确、无重叠、总数一致", async () => {
    const pairKey = `${Math.min(DEMO.alice, DEMO.team)}:${Math.max(DEMO.alice, DEMO.team)}`;
    const [conv] = (await db()
      .insert(conversations)
      .values({ pairKey, createdAt: "2026-10-26 00:00:00" })) as unknown as [{ insertId: number }];
    const convId = Number(conv.insertId);
    await db()
      .insert(conversationMembers)
      .values([
        { conversationId: convId, userId: DEMO.alice },
        { conversationId: convId, userId: DEMO.team },
      ]);
    // 批量夹具 100 条（alice 发 50、team 发 50，交替）
    const values = Array.from({ length: 100 }, (_, i) => ({
      conversationId: convId,
      senderId: i % 2 === 0 ? DEMO.alice : DEMO.team,
      body: `夹具消息 ${i + 1}`,
      createdAt: "2026-10-26 00:00:00",
    }));
    await db().insert(messages).values(values);

    const p1 = await conversationMessages(convId, 1);
    expect(p1.total).toBe(100);
    expect(p1.totalPages).toBe(4);
    expect(p1.items).toHaveLength(30);
    expect(p1.items[0].body).toBe("夹具消息 1");
    const p4 = await conversationMessages(convId, 4);
    expect(p4.items).toHaveLength(10);
    expect(p4.items[9].body).toBe("夹具消息 100");
    // 页间无重叠
    const ids1 = new Set(p1.items.map((m) => m.id));
    expect(p4.items.every((m) => !ids1.has(m.id))).toBe(true);
    // 越界页收束到尾页
    const over = await conversationMessages(convId, 99);
    expect(over.page).toBe(4);
    // 清理夹具
    await db().delete(messages).where(eq(messages.conversationId, convId));
    await db().delete(conversationMembers).where(eq(conversationMembers.conversationId, convId));
    await db().delete(conversations).where(eq(conversations.id, convId));
  });
});
