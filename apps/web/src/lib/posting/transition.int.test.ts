// @vitest-environment node
/**
 * transitionContent 的真实 MySQL 集成测试（M6.1 第 3 步）。
 * 核心是预言机：每次迁移之后，缓存计数与"最后一帖"指针都必须等于从明细重算的结果。
 * 测试只在演示版块 901 里造数据，并用同样的 SQL 口径（与迁移的 countersStep 一致）重算期望值。
 */
import { eq, sql } from "drizzle-orm";
import { DEMO, auditLog, getWebDb, posts, threads } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import type { DbTx } from "@/lib/audit";
import type { ContentState } from "@/lib/authz/evaluator";
import { POINTS_TX_OPTIONS, withDeadlockRetry } from "@/lib/points/retry";
import { transitionContent } from "./transition";

const FORUM = 901;
const AUTHOR: number = DEMO.member;
const REPLIER: number = DEMO.xiaoyi;
const OTHER: number = DEMO.alice;
const MARK = "SECRET-AUDIT-MARK";

let tdb: TempDb;
const db = () => getWebDb();
const at = (n: number) => `2026-10-21 10:${String(n).padStart(2, "0")}:00`;
const q = async (s: ReturnType<typeof sql>) =>
  ((await db().execute(s)) as unknown as [Record<string, unknown>[]])[0];

async function mkThread(
  title: string,
  n: number,
  opts: { authorId?: number; state?: ContentState; featured?: boolean; body?: string } = {},
): Promise<{ threadId: number; postId: number }> {
  const authorId = opts.authorId ?? AUTHOR;
  const state = opts.state ?? "visible";
  const [t] = (await db()
    .insert(threads)
    .values({
      forumId: FORUM,
      authorId,
      title,
      state,
      isFeatured: opts.featured ?? false,
      createdAt: at(n),
      lastPostedAt: at(n),
    })) as unknown as [{ insertId: number }];
  const threadId = Number(t.insertId);
  const [p] = (await db()
    .insert(posts)
    .values({
      threadId,
      floor: 1,
      authorId,
      bodyMd: opts.body ?? `首帖 ${title}`,
      state,
      createdAt: at(n),
    })) as unknown as [{ insertId: number }];
  const postId = Number(p.insertId);
  await db().update(threads).set({ firstPostId: postId }).where(eq(threads.id, threadId));
  return { threadId, postId };
}

async function mkReply(
  threadId: number,
  floor: number,
  n: number,
  opts: { authorId?: number; state?: ContentState } = {},
): Promise<number> {
  const [p] = (await db()
    .insert(posts)
    .values({
      threadId,
      floor,
      authorId: opts.authorId ?? REPLIER,
      bodyMd: `回帖 ${floor}`,
      state: opts.state ?? "visible",
      createdAt: at(n),
    })) as unknown as [{ insertId: number }];
  return Number(p.insertId);
}

/** 把版块、涉及的主题与作者的缓存列设为明细重算的结果（口径与迁移 countersStep 一致）。只在建数据后调用一次 */
async function reset(authors: number[] = [AUTHOR, REPLIER]) {
  await q(sql`UPDATE threads t SET
      reply_count = (SELECT COUNT(*) FROM posts p WHERE p.thread_id = t.id AND p.floor > 1 AND p.state = 'visible'),
      last_post_id = (SELECT p.id FROM posts p WHERE p.thread_id = t.id AND p.state = 'visible' ORDER BY p.floor DESC LIMIT 1),
      last_poster_id = (SELECT p.author_id FROM posts p WHERE p.thread_id = t.id AND p.state = 'visible' ORDER BY p.floor DESC LIMIT 1),
      last_posted_at = COALESCE((SELECT p.created_at FROM posts p WHERE p.thread_id = t.id AND p.state = 'visible' ORDER BY p.floor DESC LIMIT 1), t.created_at)
    WHERE t.forum_id = ${FORUM}`);
  await q(sql`UPDATE forums f SET
      thread_count = (SELECT COUNT(*) FROM threads t WHERE t.forum_id = f.id AND t.state = 'visible'),
      post_count = (SELECT COUNT(*) FROM posts p JOIN threads t ON t.id = p.thread_id WHERE t.forum_id = f.id AND t.state = 'visible' AND p.state = 'visible'),
      last_post_id = (SELECT t.last_post_id FROM threads t WHERE t.forum_id = f.id AND t.state = 'visible' ORDER BY t.last_posted_at DESC, t.id DESC LIMIT 1),
      last_posted_at = (SELECT t.last_posted_at FROM threads t WHERE t.forum_id = f.id AND t.state = 'visible' ORDER BY t.last_posted_at DESC, t.id DESC LIMIT 1)
    WHERE f.id = ${FORUM}`);
  for (const a of authors) {
    await q(
      sql`INSERT IGNORE INTO user_stats (user_id, thread_count, post_count, featured_count, follower_count) VALUES (${a}, 0, 0, 0, 0)`,
    );
    await q(sql`UPDATE user_stats us SET
        thread_count = (SELECT COUNT(*) FROM threads t WHERE t.author_id = us.user_id AND t.state = 'visible'),
        post_count = (SELECT COUNT(*) FROM posts p WHERE p.author_id = us.user_id AND p.state = 'visible'),
        featured_count = (SELECT COALESCE(SUM(t.is_featured), 0) FROM threads t WHERE t.author_id = us.user_id AND t.state = 'visible'),
        last_post_at = (SELECT MAX(p.created_at) FROM posts p WHERE p.author_id = us.user_id AND p.state = 'visible')
      WHERE us.user_id = ${a}`);
  }
}

const forumCounts = async () => {
  const [r] = await q(
    sql`SELECT thread_count tc, post_count pc, last_post_id lp FROM forums WHERE id = ${FORUM}`,
  );
  return { tc: Number(r!.tc), pc: Number(r!.pc), lp: r!.lp === null ? null : Number(r!.lp) };
};
const userCounts = async (u: number) => {
  const [r] = await q(
    sql`SELECT thread_count tc, post_count pc, featured_count fc, last_post_at lpa FROM user_stats WHERE user_id = ${u}`,
  );
  return { tc: Number(r!.tc), pc: Number(r!.pc), fc: Number(r!.fc), lpa: r!.lpa ?? null };
};

/** 预言机：缓存列必须等于明细重算的结果。失败信息带上步骤名，便于定位 */
async function expectConsistent(label: string, threadIds: number[], authors = [AUTHOR, REPLIER]) {
  const f = await forumCounts();
  const [fe] = await q(sql`SELECT
      (SELECT COUNT(*) FROM threads t WHERE t.forum_id = ${FORUM} AND t.state = 'visible') tc,
      (SELECT COUNT(*) FROM posts p JOIN threads t ON t.id = p.thread_id WHERE t.forum_id = ${FORUM} AND t.state = 'visible' AND p.state = 'visible') pc,
      (SELECT t.last_post_id FROM threads t WHERE t.forum_id = ${FORUM} AND t.state = 'visible' ORDER BY t.last_posted_at DESC, t.id DESC LIMIT 1) lp`);
  expect(f, `${label}：版块`).toEqual({
    tc: Number(fe!.tc),
    pc: Number(fe!.pc),
    lp: fe!.lp === null ? null : Number(fe!.lp),
  });
  for (const tid of threadIds) {
    const [s] = await q(
      sql`SELECT reply_count rc, last_post_id lp, last_posted_at lpa FROM threads WHERE id = ${tid}`,
    );
    const [e] = await q(sql`SELECT
        (SELECT COUNT(*) FROM posts p WHERE p.thread_id = ${tid} AND p.floor > 1 AND p.state = 'visible') rc,
        (SELECT p.id FROM posts p WHERE p.thread_id = ${tid} AND p.state = 'visible' ORDER BY p.floor DESC LIMIT 1) lp,
        COALESCE((SELECT p.created_at FROM posts p WHERE p.thread_id = ${tid} AND p.state = 'visible' ORDER BY p.floor DESC LIMIT 1),
                 (SELECT t.created_at FROM threads t WHERE t.id = ${tid})) lpa`);
    expect(
      { rc: Number(s!.rc), lp: s!.lp === null ? null : Number(s!.lp), lpa: s!.lpa },
      `${label}：主题 ${tid}`,
    ).toEqual({ rc: Number(e!.rc), lp: e!.lp === null ? null : Number(e!.lp), lpa: e!.lpa });
  }
  for (const a of authors) {
    const u = await userCounts(a);
    const [e] = await q(sql`SELECT
        (SELECT COUNT(*) FROM threads t WHERE t.author_id = ${a} AND t.state = 'visible') tc,
        (SELECT COUNT(*) FROM posts p WHERE p.author_id = ${a} AND p.state = 'visible') pc,
        (SELECT COALESCE(SUM(t.is_featured), 0) FROM threads t WHERE t.author_id = ${a} AND t.state = 'visible') fc,
        (SELECT MAX(p.created_at) FROM posts p WHERE p.author_id = ${a} AND p.state = 'visible') lpa`);
    expect({ tc: u.tc, pc: u.pc, fc: u.fc, lpa: u.lpa }, `${label}：作者 ${a}`).toEqual({
      tc: Number(e!.tc),
      pc: Number(e!.pc),
      fc: Number(e!.fc),
      lpa: e!.lpa ?? null,
    });
  }
}

const move = (postId: number, to: ContentState, opts: { reason?: string; audit?: boolean } = {}) =>
  withDeadlockRetry(() =>
    db().transaction(
      (tx) =>
        transitionContent(tx as unknown as DbTx, postId, to, { actorId: DEMO.admin, ...opts }),
      POINTS_TX_OPTIONS,
    ),
  );

describe.skipIf(skipDb)("transitionContent · 真实 MySQL 预言机", () => {
  beforeAll(async () => {
    tdb = await setupTempDb();
  });
  afterAll(async () => {
    await tdb?.teardown();
  });

  it("完整生命周期：隐藏 / 恢复 / 删除首帖 / 恢复首帖，每一步后计数与指针都等于明细重算", async () => {
    const A = await mkThread("生命周期A", 10);
    const r2 = await mkReply(A.threadId, 2, 11);
    const r3 = await mkReply(A.threadId, 3, 12);
    await reset();
    await expectConsistent("初始", [A.threadId]);
    const steps: [string, number, ContentState][] = [
      ["隐藏最新回帖", r3, "hidden"],
      ["恢复最新回帖", r3, "visible"],
      ["隐藏中间回帖", r2, "hidden"],
      ["删除首帖（主题）", A.postId, "deleted"],
      ["恢复首帖（主题）", A.postId, "visible"],
      ["恢复中间回帖", r2, "visible"],
      ["删除最新回帖", r3, "deleted"],
    ];
    for (const [label, pid, to] of steps) {
      expect(await move(pid, to), label).toMatchObject({ ok: true, changed: true, to });
      await expectConsistent(label, [A.threadId]);
    }
  });

  it("删除有回复的主题：版块帖数整体减 1+可见回帖数；回帖作者的帖数不变（设计稿 §3.1 的不对称口径）", async () => {
    const B = await mkThread("删除B", 20);
    await mkReply(B.threadId, 2, 21, { authorId: OTHER });
    await mkReply(B.threadId, 3, 22, { authorId: OTHER });
    await reset([AUTHOR, REPLIER, OTHER]);
    const f0 = await forumCounts();
    const a0 = await userCounts(AUTHOR);
    const o0 = await userCounts(OTHER);
    await move(B.postId, "deleted");
    const f1 = await forumCounts();
    expect(f1.tc - f0.tc).toBe(-1);
    expect(f1.pc - f0.pc).toBe(-3); // 首帖 + 2 条可见回帖
    expect(await userCounts(AUTHOR)).toMatchObject({ tc: a0.tc - 1, pc: a0.pc - 1 });
    expect(await userCounts(OTHER)).toEqual(o0);
    await expectConsistent("删除B后", [B.threadId]);
  });

  it("精华主题：删除再恢复，作者的精华数随可见性加减；非精华不动", async () => {
    const C = await mkThread("精华C", 25, { featured: true });
    await reset();
    const a0 = await userCounts(AUTHOR);
    await move(C.postId, "hidden");
    expect((await userCounts(AUTHOR)).fc).toBe(a0.fc - 1);
    await move(C.postId, "visible");
    expect((await userCounts(AUTHOR)).fc).toBe(a0.fc);
    const D = await mkThread("普通D", 26);
    await reset();
    const a1 = await userCounts(AUTHOR);
    await move(D.postId, "hidden");
    expect((await userCounts(AUTHOR)).fc).toBe(a1.fc);
    await expectConsistent("精华后", [C.threadId, D.threadId]);
  });

  it("同状态迁移：changed=false，任何计数与指针都不变", async () => {
    const E = await mkThread("E", 27);
    await reset();
    const f0 = await forumCounts();
    const a0 = await userCounts(AUTHOR);
    expect(await move(E.postId, "visible")).toMatchObject({ ok: true, changed: false });
    expect(await forumCounts()).toEqual(f0);
    expect(await userCounts(AUTHOR)).toEqual(a0);
  });

  it("不存在的帖子 → not_found，不写任何东西", async () => {
    expect(await move(999_999_999, "hidden")).toEqual({ ok: false, code: "not_found" });
  });

  it("主题与首帖状态分叉时拒绝迁移：抛错，且事务回滚，任何数据都没改", async () => {
    const F = await mkThread("分叉F", 28);
    await reset();
    await db().update(threads).set({ state: "hidden" }).where(eq(threads.id, F.threadId));
    const f0 = await forumCounts();
    const a0 = await userCounts(AUTHOR);
    await expect(move(F.postId, "deleted")).rejects.toThrow(/分叉/);
    expect(await forumCounts()).toEqual(f0);
    expect(await userCounts(AUTHOR)).toEqual(a0);
    const [p] = await db().select({ state: posts.state }).from(posts).where(eq(posts.id, F.postId));
    expect(p?.state).toBe("visible");
  });

  it("审计：audit=true 写一条 post.state.<目标状态>，记录前后状态与理由；正文标记不进审计；audit=false 不写", async () => {
    const G = await mkThread(`审计G ${MARK}`, 29, { body: `首帖正文 ${MARK}` });
    await reset();
    await move(G.postId, "hidden", { audit: true, reason: "广告引流" });
    const rows = await db()
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, String(G.postId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "post.state.hidden",
      targetType: "post",
      actorId: DEMO.admin,
    });
    expect(JSON.stringify(rows[0])).toContain("广告引流");
    expect(JSON.stringify(rows)).not.toContain(MARK);
    await move(G.postId, "visible", { audit: false });
    expect(
      await db()
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, String(G.postId))),
    ).toHaveLength(1);
  });

  it("恢复一条旧帖不得让版块的最后活跃时间回退（前移指针的回归：旧实现会把版块指向这条旧帖）", async () => {
    const H = await mkThread("H", 30);
    const h2 = await mkReply(H.threadId, 2, 31, { authorId: OTHER });
    const I = await mkThread("I", 40);
    const i2 = await mkReply(I.threadId, 2, 41, { authorId: OTHER });
    await reset([AUTHOR, REPLIER, OTHER]);
    expect((await forumCounts()).lp).toBe(i2); // 版块最新活动在 I
    await move(h2, "hidden");
    await move(h2, "visible");
    expect((await forumCounts()).lp).toBe(i2);
    expect((await userCounts(OTHER)).lpa).toBe(at(41));
    await expectConsistent("恢复旧帖后", [H.threadId, I.threadId], [AUTHOR, REPLIER, OTHER]);
  });

  it("并发（跨主题）：同一版块的 6 个主题里各有回帖并发隐藏 / 恢复——版块指针与版块计数必须仍等于明细重算（版块行锁的职责）", async () => {
    const threads6: number[] = [];
    const flips: number[] = [];
    for (let i = 0; i < 6; i++) {
      const t = await mkThread(`跨主题${i}`, 2 + i * 6);
      threads6.push(t.threadId);
      flips.push(await mkReply(t.threadId, 2, 3 + i * 6), await mkReply(t.threadId, 3, 4 + i * 6));
    }
    await reset();
    const toHide = await Promise.all(flips.map((id) => move(id, "hidden")));
    expect(toHide.every((r) => r.ok && r.changed)).toBe(true);
    await expectConsistent("跨主题并发隐藏后", threads6);
    const toRestore = await Promise.all(
      flips.map((id, i) => move(id, i % 3 === 0 ? "deleted" : "visible")),
    );
    expect(toRestore.every((r) => r.ok && r.changed)).toBe(true);
    await expectConsistent("跨主题并发恢复后", threads6);
  });

  it("并发：同一主题上 8 条回帖同时隐藏 / 恢复，最终计数与指针仍等于明细重算（无死锁，重试后收敛）", async () => {
    const K = await mkThread("并发K", 50);
    const replies: number[] = [];
    for (let i = 0; i < 8; i++) replies.push(await mkReply(K.threadId, i + 2, 51 + i));
    await reset();
    const hide = await Promise.all(replies.map((id) => move(id, "hidden")));
    expect(hide.every((r) => r.ok && r.changed)).toBe(true);
    await expectConsistent("并发隐藏后", [K.threadId]);
    const flip = await Promise.all(
      replies.map((id, i) => move(id, i % 2 === 0 ? "visible" : "deleted")),
    );
    expect(flip.every((r) => r.ok && r.changed)).toBe(true);
    await expectConsistent("并发混合后", [K.threadId]);
  });
});
