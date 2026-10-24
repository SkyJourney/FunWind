// @vitest-environment node
/**
 * transitionContent 的真实 MySQL 集成测试（M6.1 第 3 步）。
 * 核心是预言机：每次迁移之后，缓存计数与"最后一帖"指针都必须等于从明细重算的结果。
 * 测试只在演示版块 901 里造数据，并用同样的 SQL 口径（与迁移的 countersStep 一致）重算期望值。
 */
import { eq } from "drizzle-orm";
import { DEMO, auditLog, getWebDb, posts, threads } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import type { DbTx } from "@/lib/audit";
import type { ContentState } from "@/lib/authz/evaluator";
import { POINTS_TX_OPTIONS, withDeadlockRetry } from "@/lib/points/retry";
import { transitionContent } from "./transition";
import { at, makeOracle } from "@/test/posting-oracle";

const FORUM = 901;
const AUTHOR: number = DEMO.member;
const REPLIER: number = DEMO.xiaoyi;
const OTHER: number = DEMO.alice;
const MARK = "SECRET-AUDIT-MARK";

let tdb: TempDb;
const db = () => getWebDb();
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

const O = makeOracle(FORUM, [AUTHOR, REPLIER]);
const { reset, forumCounts, userCounts, expectConsistent } = O;

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
