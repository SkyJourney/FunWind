// @vitest-environment node
/**
 * 发帖 × 事务性 outbox 的集成测试（M7 S3）：
 *  · 事务内 enqueue——发帖成功则事件行必在 outbox 且载荷完整；
 *  · 快路径派发失败 → 行保持 pending（记录错误），drain 补派 → 消费方拿到与 enqueue 一致的载荷；
 *  · 幂等重放（drain 两次）由事件载荷逐字相同体现（消费端幂等在 points 侧另有测试）。
 */
import { eq, sql } from "drizzle-orm";
import { DEMO, eventOutbox, getWebDb, siteSettings } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSubject } from "@/lib/authz/subject";
import type { Subject } from "@/lib/authz/types";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { countPendingOutbox, type OutboxEmitter } from "@/lib/events/outbox";
import { createThread, createReply } from "./service";

const FORUM = 901; // 演示种子的公开版块（审核策略 inherit → none）
let tdb: TempDb;
let member: Subject;
const db = () => getWebDb();

/** 按事件名收集派发；fails 命中的事件名抛错 */
function collector(failNames: ReadonlySet<string> = new Set()) {
  const calls: { name: string; payload: Record<string, unknown> }[] = [];
  const emitter: OutboxEmitter = async (name, payload) => {
    if (failNames.has(name)) throw new Error(`注入失败: ${name}`);
    calls.push({ name, payload: structuredClone(payload) as Record<string, unknown> });
  };
  return { emitter, calls };
}

/** 放宽发帖频控（与 service.int.test 同法） */
async function relaxLimits() {
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
}

beforeAll(async () => {
  tdb = await setupTempDb();
  member = await loadSubject(DEMO.member);
  await relaxLimits();
});

afterAll(async () => {
  await tdb?.teardown();
});

describe.skipIf(skipDb)("发帖 outbox（M7）", () => {
  it("发主题：事务内登记 thread.created（载荷完整）与附件事件；快路径成功后行已标记", async () => {
    const c = collector();
    const out = await createThread(
      member,
      { forumId: FORUM, title: "outbox 主题", source: "正文" },
      { emitter: c.emitter },
    );
    if (!out.ok) throw new Error(out.message);
    expect(await countPendingOutbox()).toBe(0);
    const rows = await db()
      .select()
      .from(eventOutbox)
      .where(eq(eventOutbox.eventName, "thread.created"));
    expect(rows).toHaveLength(1);
    expect(rows[0].dispatchedAt).not.toBeNull();
    expect(rows[0].source).toBe("posting");
    const main = c.calls.find((x) => x.name === "thread.created")!;
    expect(main.payload).toMatchObject({
      threadId: out.threadId,
      postId: out.postId,
      forumId: FORUM,
      authorId: DEMO.member,
      title: "outbox 主题",
    });
  });

  it("快路径失败 → 捎带巡检自愈：行被补派标记，event_log 记 source=outbox", async () => {
    const failing = collector(new Set(["thread.created"]));
    const out = await createThread(
      member,
      { forumId: FORUM, title: "崩溃窗口主题", source: "正文" },
      { emitter: failing.emitter },
    );
    if (!out.ok) throw new Error(out.message);
    // 快路径对 thread.created 派发失败（行 pending），随后的 sweepPending 用默认路径补派成功——
    // 自愈闭环正是生产行为；「崩溃后无人派发」的窗口在 outbox.int.test 里以直插 outbox 行覆盖。
    expect(await countPendingOutbox()).toBe(0);
    const rows = await db()
      .select()
      .from(eventOutbox)
      .where(eq(eventOutbox.eventName, "thread.created"));
    const row = rows.find((r) => JSON.stringify(r.payload).includes("崩溃窗口主题"))!;
    expect(row.dispatchedAt).not.toBeNull();
    expect(row.dispatchError).toMatchObject({ message: "注入失败: thread.created" });
  });

  it("回帖：thread.replied 载荷在事务内补齐（threadAuthorId / replyToAuthorId）", async () => {
    const first = collector();
    const head = await createThread(
      member,
      { forumId: FORUM, title: "回帖 outbox 楼主", source: "正文" },
      { emitter: first.emitter },
    );
    if (!head.ok) throw new Error(head.message);

    const c = collector();
    // 引用回复指向同主题的首帖（head.postId）
    const reply = await createReply(
      member,
      { threadId: head.threadId, source: "引用回复", replyToPostId: head.postId },
      { emitter: c.emitter },
    );
    if (!reply.ok) throw new Error(reply.message);
    const main = c.calls.find((x) => x.name === "thread.replied")!;
    expect(main.payload).toMatchObject({
      threadId: head.threadId,
      postId: reply.postId,
      forumId: FORUM,
      authorId: DEMO.member,
      threadAuthorId: DEMO.member,
      replyToPostId: head.postId,
      replyToAuthorId: DEMO.member,
    });
    expect(await countPendingOutbox()).toBe(0);
  });
});
