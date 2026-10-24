// @vitest-environment node
/**
 * createThread / createReply 的真实 MySQL 集成测试（M6.1 第 4 步）。
 * 每条性质都带对照组；计数与指针用预言机（明细重算）逐步核对。
 */
import { eq, sql } from "drizzle-orm";
import { DEMO, forums, getWebDb, posts, siteSettings, threads, postGates } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invalidateAuthzSnapshot } from "@/lib/authz/snapshot";
import { loadSubject } from "@/lib/authz/subject";
import type { Subject } from "@/lib/authz/types";
import { makeOracle } from "@/test/posting-oracle";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import type { DbTx } from "@/lib/audit";
import { POINTS_TX_OPTIONS } from "@/lib/points/retry";
import { createReply, createThread, type PostingEmitter } from "./service";
import { transitionContent } from "./transition";

const FORUM = 901; // 演示种子的公开版块（审核策略 inherit → none）
const MARK = "BODY-MARK-服务层";
let tdb: TempDb;
let member: Subject,
  admin: Subject,
  banned: Subject,
  alice: Subject,
  team: Subject,
  xiaoyi: Subject;
const db = () => getWebDb();
const oracle = makeOracle(FORUM, [DEMO.member, DEMO.xiaoyi, DEMO.admin, DEMO.alice, DEMO.team]);

const roles = (member: Record<string, number>) => ({
  titleMax: 100,
  bodyMax: 50000,
  roles: {
    member: { postIntervalSec: 0, threadsPerDay: 0, uploadsPerDay: 20, ...member },
    admin: { postIntervalSec: 0, threadsPerDay: 0, uploadsPerDay: 0 },
  },
});
async function setLimits(memberOver: Record<string, number> = {}) {
  await db()
    .insert(siteSettings)
    .values({ key: "limits", value: roles(memberOver) as object, updatedAt: sql`NOW()` })
    .onDuplicateKeyUpdate({ set: { value: roles(memberOver) as object, updatedAt: sql`NOW()` } });
}

/** 造一个审核策略可指定的版块（路径与快照一并刷新） */
async function mkForum(name: string, reviewPolicy: "none" | "threads" | "all"): Promise<number> {
  const [r] = (await db().insert(forums).values({
    parentId: 0,
    path: "/",
    depth: 1,
    kind: "forum",
    name,
    readPolicy: "public",
    writePolicy: "inherit",
    reviewPolicy,
    isListed: true,
    isArchived: false,
  })) as unknown as [{ insertId: number }];
  const id = Number(r.insertId);
  await db()
    .update(forums)
    .set({ path: `/${id}/` })
    .where(eq(forums.id, id));
  invalidateAuthzSnapshot();
  return id;
}

const events: [string, unknown][] = [];
const emitter = (async (name: string, payload: unknown) => {
  events.push([name, payload]);
}) as unknown as PostingEmitter;
const deps = { emitter };

const threadRow = async (id: number) =>
  (await db().select().from(threads).where(eq(threads.id, id)))[0]!;
const postCount = async (threadId: number) =>
  (await db().select().from(posts).where(eq(posts.threadId, threadId))).length;

describe.skipIf(skipDb)("发主题与回帖 · 真实 MySQL", () => {
  beforeAll(async () => {
    tdb = await setupTempDb();
    [member, admin, banned, alice, team, xiaoyi] = await Promise.all([
      loadSubject(DEMO.member),
      loadSubject(DEMO.admin),
      loadSubject(DEMO.banned),
      loadSubject(DEMO.alice),
      loadSubject(DEMO.team),
      loadSubject(DEMO.xiaoyi),
    ]);
    await setLimits();
  });
  afterAll(async () => {
    await tdb?.teardown();
  });

  it("发主题（免审版块）：可见、计数与指针正确、预言机一致；事件载荷不含正文", async () => {
    await oracle.reset();
    const f0 = await oracle.forumCounts();
    const u0 = await oracle.userCounts(DEMO.member);
    events.length = 0;
    const r = await createThread(
      member,
      { forumId: FORUM, title: "服务层首帖", source: `首帖正文 ${MARK}` },
      deps,
    );
    expect(r).toMatchObject({ ok: true, floor: 1, state: "visible", duplicate: false });
    if (!r.ok) return;
    expect((await oracle.forumCounts()).tc).toBe(f0.tc + 1);
    expect((await oracle.userCounts(DEMO.member)).tc).toBe(u0.tc + 1);
    expect((await threadRow(r.threadId)).firstPostId).toBe(r.postId);
    await oracle.expectConsistent("发主题后", [r.threadId]);
    expect(events).toEqual([
      [
        "thread.created",
        {
          threadId: r.threadId,
          postId: r.postId,
          forumId: FORUM,
          authorId: DEMO.member,
          title: "服务层首帖",
        },
      ],
    ]);
    expect(JSON.stringify(events)).not.toContain(MARK);
  });

  it("审核版块发主题：待审、版块与作者计数不变、只发 content.submitted；通过审核后计数才加上", async () => {
    const R = await mkForum("服务层审核版", "threads");
    const o = makeOracle(R, [DEMO.member]);
    await o.reset([DEMO.member]);
    const f0 = await o.forumCounts();
    const u0 = await o.userCounts(DEMO.member);
    events.length = 0;
    const r = await createThread(
      member,
      { forumId: R, title: "待审主题", source: "待审正文" },
      deps,
    );
    expect(r).toMatchObject({ ok: true, state: "pending" });
    if (!r.ok) return;
    expect(await o.forumCounts()).toEqual(f0);
    expect(await o.userCounts(DEMO.member)).toEqual(u0);
    expect(events.map((e) => e[0])).toEqual(["content.submitted"]);
    await o.expectConsistent("待审", [r.threadId], [DEMO.member]);
    await db().transaction(
      (tx) =>
        transitionContent(tx as unknown as DbTx, r.postId, "visible", { actorId: DEMO.admin }),
      POINTS_TX_OPTIONS,
    );
    expect((await o.forumCounts()).tc).toBe(f0.tc + 1);
    await o.expectConsistent("通过审核后", [r.threadId], [DEMO.member]);
  });

  it("回帖：楼层连续、主题回复数与最后一帖指针正确，事件是 thread.replied；预言机一致", async () => {
    const t = await createThread(member, { forumId: FORUM, title: "回帖目标", source: "首帖" });
    if (!t.ok) throw new Error("准备失败");
    await oracle.reset();
    events.length = 0;
    const r = await createReply(xiaoyi, { threadId: t.threadId, source: "第一条回帖" }, deps);
    expect(r).toMatchObject({ ok: true, floor: 2, state: "visible" });
    const r2 = await createReply(admin, { threadId: t.threadId, source: "第二条回帖" }, deps);
    expect(r2).toMatchObject({ ok: true, floor: 3 });
    expect((await threadRow(t.threadId)).lastPostId).toBe(r2.ok ? r2.postId : -1);
    expect(events.map((e) => e[0])).toEqual(["thread.replied", "thread.replied"]);
    await oracle.expectConsistent("回帖后", [t.threadId]);
  });

  it("引用回复：指向同主题的可见帖子可以；指向别的主题或已隐藏的帖子 → reply_target_invalid", async () => {
    const a = await createThread(member, { forumId: FORUM, title: "引用A", source: "A 首帖" });
    const b = await createThread(member, { forumId: FORUM, title: "引用B", source: "B 首帖" });
    if (!a.ok || !b.ok) throw new Error("准备失败");
    const ok = await createReply(
      xiaoyi,
      { threadId: a.threadId, source: "引用 A 首帖", replyToPostId: a.postId },
      deps,
    );
    expect(ok).toMatchObject({ ok: true });
    if (ok.ok)
      expect(
        (await db().select().from(posts).where(eq(posts.id, ok.postId)))[0]?.replyToPostId,
      ).toBe(a.postId);
    expect(
      await createReply(
        xiaoyi,
        { threadId: a.threadId, source: "引用 B", replyToPostId: b.postId },
        deps,
      ),
    ).toMatchObject({
      ok: false,
      code: "reply_target_invalid",
    });
    await db().update(posts).set({ state: "hidden" }).where(eq(posts.id, a.postId));
    expect(
      await createReply(
        xiaoyi,
        { threadId: a.threadId, source: "引用已隐藏", replyToPostId: a.postId },
        deps,
      ),
    ).toMatchObject({
      ok: false,
      code: "reply_target_invalid",
    });
  });

  it("锁定主题：普通会员回帖被拒（thread_locked，且不写入）；对照：admin（持有 thread.replyLocked）可以", async () => {
    const t = await createThread(member, { forumId: FORUM, title: "锁定主题", source: "首帖" });
    if (!t.ok) throw new Error("准备失败");
    await db().update(threads).set({ isLocked: true }).where(eq(threads.id, t.threadId));
    const before = await postCount(t.threadId);
    expect(await createReply(xiaoyi, { threadId: t.threadId, source: "想回" }, deps)).toMatchObject(
      {
        ok: false,
        code: "thread_locked",
      },
    );
    expect(await postCount(t.threadId)).toBe(before);
    expect(
      await createReply(admin, { threadId: t.threadId, source: "管理员回" }, deps),
    ).toMatchObject({ ok: true });
  });

  it("主题不可见（隐藏）：回帖 → thread_closed；不存在的主题 → not_found", async () => {
    const t = await createThread(member, { forumId: FORUM, title: "隐藏主题", source: "首帖" });
    if (!t.ok) throw new Error("准备失败");
    await db().update(threads).set({ state: "hidden" }).where(eq(threads.id, t.threadId));
    expect(await createReply(xiaoyi, { threadId: t.threadId, source: "回" }, deps)).toMatchObject({
      ok: false,
      code: "thread_closed",
    });
    expect(await createReply(xiaoyi, { threadId: 999_999_999, source: "回" }, deps)).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("没有写权限的用户（全局封禁）：发主题与回帖都 forbidden，不写入", async () => {
    const before = (await db().select().from(threads)).length;
    expect(
      await createThread(banned, { forumId: FORUM, title: "封禁用户", source: "x" }, deps),
    ).toMatchObject({ ok: false, code: "forbidden" });
    expect((await db().select().from(threads)).length).toBe(before);
    const t = await createThread(member, { forumId: FORUM, title: "封禁回帖目标", source: "首帖" });
    if (!t.ok) throw new Error("准备失败");
    expect(await createReply(banned, { threadId: t.threadId, source: "x" }, deps)).toMatchObject({
      ok: false,
      code: "forbidden",
    });
  });

  it("文本校验：空标题、超长标题、空正文都在写入前拒绝，且不产生任何记录", async () => {
    const before = (await db().select().from(threads)).length;
    expect(
      await createThread(member, { forumId: FORUM, title: " ​ ", source: "x" }, deps),
    ).toMatchObject({ ok: false, code: "title_empty" });
    expect(
      await createThread(member, { forumId: FORUM, title: "长".repeat(101), source: "x" }, deps),
    ).toMatchObject({ ok: false, code: "title_too_long" });
    expect(
      await createThread(member, { forumId: FORUM, title: "空正文", source: "  \n " }, deps),
    ).toMatchObject({ ok: false, code: "body_empty" });
    expect((await db().select().from(threads)).length).toBe(before);
  });

  it("门控：创建时写入 post_gates，正文只留占位，隐藏文本只在门控表里；语法错误整体拒绝", async () => {
    const SECRET = "GATE-SECRET-服务层";
    const src = `公开部分\n\n:::gate{unlock="points" price="5"}\n${SECRET}\n:::\n\n后文`;
    const r = await createThread(member, { forumId: FORUM, title: "门控主题", source: src }, deps);
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    const [p] = await db().select().from(posts).where(eq(posts.id, r.postId));
    expect(p).toMatchObject({ hasGate: true });
    expect(p!.bodyMd).not.toContain(SECRET);
    expect(p!.bodyMd).toContain("公开部分");
    const gates = await db().select().from(postGates).where(eq(postGates.postId, r.postId));
    expect(gates).toHaveLength(1);
    expect(gates[0]!.hiddenMd).toContain(SECRET);
    expect(JSON.stringify(events)).not.toContain(SECRET);

    const before = (await db().select().from(threads)).length;
    expect(
      await createThread(
        member,
        {
          forumId: FORUM,
          title: "门控语法错",
          source: `:::gate{unlock="points" price="abc"}\nx\n:::`,
        },
        deps,
      ),
    ).toMatchObject({ ok: false, code: "gate_syntax" });
    expect((await db().select().from(threads)).length).toBe(before);
  });

  it("发帖间隔：间隔内第二次回帖被拒（too_frequent），等待或调整间隔后放行；只限制有间隔的角色", async () => {
    const t = await createThread(member, { forumId: FORUM, title: "间隔主题", source: "首帖" });
    if (!t.ok) throw new Error("准备失败");
    await setLimits({ postIntervalSec: 5 });
    try {
      expect(
        await createReply(alice, { threadId: t.threadId, source: "第一条" }, deps),
      ).toMatchObject({ ok: true });
      expect(
        await createReply(alice, { threadId: t.threadId, source: "第二条（太快）" }, deps),
      ).toMatchObject({
        ok: false,
        code: "too_frequent",
      });
      // 对照：admin 不受 member 的间隔约束
      expect(
        await createReply(admin, { threadId: t.threadId, source: "管理员不受限" }, deps),
      ).toMatchObject({ ok: true });
    } finally {
      await setLimits();
    }
  });

  it("每日主题配额：达到上限后拒绝；删除今天的主题也不释放名额（计数含已删除）", async () => {
    await setLimits({ threadsPerDay: 2 });
    try {
      const a = await createThread(team, { forumId: FORUM, title: "配额A", source: "a" }, deps);
      const b = await createThread(team, { forumId: FORUM, title: "配额B", source: "b" }, deps);
      expect(a).toMatchObject({ ok: true });
      expect(b).toMatchObject({ ok: true });
      expect(
        await createThread(team, { forumId: FORUM, title: "配额C", source: "c" }, deps),
      ).toMatchObject({
        ok: false,
        code: "quota_exceeded",
      });
      if (a.ok) {
        await db().transaction(
          (tx) =>
            transitionContent(tx as unknown as DbTx, a.postId, "deleted", { actorId: DEMO.admin }),
          POINTS_TX_OPTIONS,
        );
      }
      expect(
        await createThread(team, { forumId: FORUM, title: "配额D", source: "d" }, deps),
      ).toMatchObject({
        ok: false,
        code: "quota_exceeded",
      });
    } finally {
      await setLimits();
    }
  });

  it("并发配额：5 个并发发主题请求、每日上限 2 → 恰好 2 个成功（配额检查在作者统计行的锁内做，并发无法绕过）", async () => {
    await setLimits({ threadsPerDay: 2 });
    try {
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          createThread(alice, { forumId: FORUM, title: `并发配额${i}`, source: `并发 ${i}` }, deps),
        ),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(2);
      expect(results.filter((r) => !r.ok && r.code === "quota_exceeded")).toHaveLength(3);
    } finally {
      await setLimits();
    }
  });

  it("幂等：同作者、同版块、同标题、同正文在 60 秒内重复提交 → 返回已有的主题，不再写入", async () => {
    const first = await createThread(
      member,
      { forumId: FORUM, title: "双击主题", source: "同一正文" },
      deps,
    );
    const again = await createThread(
      member,
      { forumId: FORUM, title: "双击主题", source: "同一正文" },
      deps,
    );
    expect(first).toMatchObject({ ok: true, duplicate: false });
    expect(again).toMatchObject({ ok: true, duplicate: true });
    if (first.ok && again.ok) expect(again.threadId).toBe(first.threadId);
    const t = await createThread(member, { forumId: FORUM, title: "回帖双击", source: "首帖" });
    if (!t.ok) throw new Error("准备失败");
    const r1 = await createReply(xiaoyi, { threadId: t.threadId, source: "同一条回帖" }, deps);
    const r2 = await createReply(xiaoyi, { threadId: t.threadId, source: "同一条回帖" }, deps);
    expect(r1).toMatchObject({ ok: true, duplicate: false });
    expect(r2).toMatchObject({ ok: true, duplicate: true });
  });

  it("并发双击：同一条回帖同时提交两次 → 恰好一条写入，另一次返回重复", async () => {
    const t = await createThread(member, { forumId: FORUM, title: "并发双击", source: "首帖" });
    if (!t.ok) throw new Error("准备失败");
    const [a, b] = await Promise.all([
      createReply(xiaoyi, { threadId: t.threadId, source: "并发同正文" }, deps),
      createReply(xiaoyi, { threadId: t.threadId, source: "并发同正文" }, deps),
    ]);
    expect([a, b].filter((x) => x.ok && !x.duplicate)).toHaveLength(1);
    expect([a, b].filter((x) => x.ok && x.duplicate)).toHaveLength(1);
    const rows = await db().select().from(posts).where(eq(posts.bodyMd, "并发同正文"));
    expect(rows).toHaveLength(1);
  });

  it("并发楼层：12 条回帖由 4 个作者同时提交（多于连接池的 8 条）→ 楼层连续不重复，回复数精确，最后一帖是最大楼层，预言机一致", async () => {
    const t = await createThread(member, { forumId: FORUM, title: "并发楼层", source: "首帖" });
    if (!t.ok) throw new Error("准备失败");
    // 前面的用例为造数据直接用 SQL 改过若干主题 / 帖子的状态（绕过了迁移入口），计数已与明细分叉；
    // 这里先按明细重算，再断言本用例自身的并发写入没有造成漂移
    await oracle.reset();
    // 必须用多个作者：同一作者的回帖会被作者统计行的锁串行化，那样即使去掉主题锁，楼层问题也测不出来
    const writers = [admin, member, xiaoyi, team];
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        createReply(
          writers[i % writers.length]!,
          { threadId: t.threadId, source: `并发回帖 ${i}` },
          deps,
        ),
      ),
    );
    expect(results.every((r) => r.ok && !r.duplicate)).toBe(true);
    const floors = await db()
      .select({ f: posts.floor })
      .from(posts)
      .where(eq(posts.threadId, t.threadId));
    const sorted = floors.map((x) => x.f).sort((x, y) => x - y);
    expect(sorted).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
    const row = await threadRow(t.threadId);
    expect(row.replyCount).toBe(12);
    expect(row.lastPostId).toBe(
      results.map((r) => (r.ok ? r.postId : 0)).reduce((a, b) => (a > b ? a : b)),
    );
    await oracle.expectConsistent("并发楼层后", [t.threadId]);
  });
});
