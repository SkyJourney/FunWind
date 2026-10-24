// @vitest-environment node
/**
 * locatePost 的真实 MySQL 集成测试（M6.1 第 6 步）。
 * 核心：页码按**观众**可见的回帖数算——隐藏 / 待审 / 已删的中间楼层不计入；不同观众看到的页码可以不同；
 * 不可见的帖子返回 null（调用方当作不存在）。
 */
import { eq } from "drizzle-orm";
import { DEMO, getWebDb, posts, threads } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSubject } from "@/lib/authz/subject";
import type { Subject } from "@/lib/authz/types";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { locateParents, locatePost, pageForReplyIndex } from "./locate-post";

const FORUM = 901; // 公开版块
const db = () => getWebDb();
const at = (n: number) => `2026-10-21 10:${String(n).padStart(2, "0")}:00`;

let tdb: TempDb;
let guest: Subject, member: Subject, admin: Subject;

/** 造一个 25 条回帖的主题：楼层 2–26 */
async function mkLongThread(
  forumId: number,
  authorId: number,
  n0: number,
): Promise<{ threadId: number; first: number; replies: number[] }> {
  const [t] = (await db()
    .insert(threads)
    .values({
      forumId,
      authorId,
      title: `定位测试 ${n0}`,
      state: "visible",
      createdAt: at(n0),
      lastPostedAt: at(n0),
    })) as unknown as [{ insertId: number }];
  const threadId = Number(t.insertId);
  const [f] = (await db()
    .insert(posts)
    .values({
      threadId,
      floor: 1,
      authorId,
      bodyMd: "首帖",
      state: "visible",
      createdAt: at(n0),
    })) as unknown as [{ insertId: number }];
  const first = Number(f.insertId);
  await db().update(threads).set({ firstPostId: first }).where(eq(threads.id, threadId));
  const replies: number[] = [];
  for (let floor = 2; floor <= 26; floor++) {
    const [p] = (await db()
      .insert(posts)
      .values({
        threadId,
        floor,
        authorId: DEMO.xiaoyi,
        bodyMd: `楼 ${floor}`,
        state: "visible",
        createdAt: at(n0),
      })) as unknown as [{ insertId: number }];
    replies[floor - 2] = Number(p.insertId);
  }
  return { threadId, first, replies };
}
const replyAt = (r: number[], floor: number) => r[floor - 2]!;

describe.skipIf(skipDb)("locatePost · 真实 MySQL", () => {
  beforeAll(async () => {
    tdb = await setupTempDb();
    [guest, member, admin] = await Promise.all([
      loadSubject(null),
      loadSubject(DEMO.member),
      loadSubject(DEMO.admin),
    ]);
  });
  afterAll(async () => {
    await tdb?.teardown();
  });

  it("没有隐藏楼层时与旧公式一致（对照）：楼层 21 在第 1 页，楼层 22 在第 2 页", async () => {
    const t = await mkLongThread(FORUM, DEMO.member, 1);
    expect(await locatePost(guest, replyAt(t.replies, 21))).toMatchObject({
      threadId: t.threadId,
      floor: 21,
      page: 1,
    });
    expect(await locatePost(guest, replyAt(t.replies, 22))).toMatchObject({ page: 2 });
    expect(await locatePost(guest, t.first)).toMatchObject({ floor: 1, page: 1 });
  });

  it("隐藏的中间楼层不计入页码：楼层 2–5 隐藏后，楼层 22 对游客仍在第 1 页（旧公式会给第 2 页）", async () => {
    const t = await mkLongThread(FORUM, DEMO.member, 2);
    for (const f of [2, 3, 4, 5])
      await db()
        .update(posts)
        .set({ state: "hidden" })
        .where(eq(posts.id, replyAt(t.replies, f)));
    const loc = await locatePost(guest, replyAt(t.replies, 22));
    expect(loc).toMatchObject({ floor: 22, page: 1 });
    expect(pageForReplyIndex(22 - 1) === loc!.page).toBe(false); // 对照：旧楼层公式在这里是错的
  });

  it("不同观众看到的页码不同：版主可以看到被隐藏的楼层，所以同一条帖子在版主视角是第 2 页", async () => {
    const t = await mkLongThread(FORUM, DEMO.member, 3);
    for (const f of [2, 3, 4, 5])
      await db()
        .update(posts)
        .set({ state: "hidden" })
        .where(eq(posts.id, replyAt(t.replies, f)));
    const g = await locatePost(guest, replyAt(t.replies, 22));
    const a = await locatePost(admin, replyAt(t.replies, 22));
    expect(g!.page).toBe(1);
    expect(a!.page).toBe(2);
  });

  it("隐藏的帖子本身：游客与普通会员定位不到（null）；版主可以", async () => {
    const t = await mkLongThread(FORUM, DEMO.member, 4);
    await db()
      .update(posts)
      .set({ state: "hidden" })
      .where(eq(posts.id, replyAt(t.replies, 3)));
    expect(await locatePost(guest, replyAt(t.replies, 3))).toBeNull();
    expect(await locatePost(member, replyAt(t.replies, 3))).toBeNull();
    expect(await locatePost(admin, replyAt(t.replies, 3))).toMatchObject({ floor: 3 });
  });

  it("待审核的回帖：只有作者与版主可以定位；对照：其他人定位不到", async () => {
    const t = await mkLongThread(FORUM, DEMO.member, 5);
    await db()
      .update(posts)
      .set({ state: "pending", authorId: DEMO.xiaoyi })
      .where(eq(posts.id, replyAt(t.replies, 7)));
    expect(await locatePost(guest, replyAt(t.replies, 7))).toBeNull();
    expect(await locatePost(member, replyAt(t.replies, 7))).toBeNull();
    expect(await locatePost(await loadSubject(DEMO.xiaoyi), replyAt(t.replies, 7))).toMatchObject({
      floor: 7,
    });
    expect(await locatePost(admin, replyAt(t.replies, 7))).toMatchObject({ floor: 7 });
  });

  it("所在主题不可见（隐藏）：其中的帖子一律定位不到，即使帖子本身可见", async () => {
    const t = await mkLongThread(FORUM, DEMO.member, 6);
    await db().update(threads).set({ state: "hidden" }).where(eq(threads.id, t.threadId));
    expect(await locatePost(guest, replyAt(t.replies, 10))).toBeNull();
    expect(await locatePost(admin, replyAt(t.replies, 10))).toMatchObject({ floor: 10 });
  });

  it("受限版块（904）里的帖子：没有读权限的会员定位不到；有权限的团队成员可以", async () => {
    const t = await mkLongThread(904, DEMO.team, 7);
    expect(await locatePost(member, replyAt(t.replies, 5))).toBeNull();
    expect(await locatePost(await loadSubject(DEMO.team), replyAt(t.replies, 5))).toMatchObject({
      floor: 5,
    });
  });

  it("不存在的帖子 → null（与不可见同一结果，不泄露存在性）", async () => {
    expect(await locatePost(guest, 999_999_999)).toBeNull();
  });

  it("父帖批量定位：不可见的父帖映射为 null（不泄露它的楼层），可见的给出位置", async () => {
    const t = await mkLongThread(FORUM, DEMO.member, 8);
    await db()
      .update(posts)
      .set({ state: "hidden" })
      .where(eq(posts.id, replyAt(t.replies, 4)));
    const m = await locateParents(guest, [replyAt(t.replies, 4), replyAt(t.replies, 6), t.first]);
    expect(m.get(replyAt(t.replies, 4))).toBeNull();
    expect(m.get(replyAt(t.replies, 6))).toMatchObject({ floor: 6 });
    expect(m.get(t.first)).toMatchObject({ floor: 1, page: 1 });
  });
});
