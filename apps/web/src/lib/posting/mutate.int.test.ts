// @vitest-environment node
/**
 * 编辑 / 删除 / 恢复的真实 MySQL 集成测试（M6.1 第 5 步）。每条性质带对照组；计数用预言机核对。
 */
import { eq, sql } from "drizzle-orm";
import {
  DEMO,
  auditLog,
  forums,
  gateUnlocks,
  getWebDb,
  postGates,
  posts,
  siteSettings,
  threads,
} from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invalidateAuthzSnapshot } from "@/lib/authz/snapshot";
import { loadSubject } from "@/lib/authz/subject";
import type { Subject } from "@/lib/authz/types";
import type { DbTx } from "@/lib/audit";
import { makeOracle } from "@/test/posting-oracle";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { POINTS_TX_OPTIONS } from "@/lib/points/retry";
import { createReply, createThread, type PostingEmitter } from "./service";
import { deletePost, editPost, restorePost, type MutateDeps } from "./mutate";
import { transitionContent } from "./transition";

const FORUM = 901;
const AUTHOR: number = DEMO.member;
const REPLIER: number = DEMO.xiaoyi;
const MARK = "MUTATE-内容标记";
let tdb: TempDb;
let member: Subject, admin: Subject, xiaoyi: Subject;
const db = () => getWebDb();
const oracle = makeOracle(FORUM, [AUTHOR, REPLIER, DEMO.team]);

const events: [string, unknown][] = [];
const deps: MutateDeps = {
  emitter: (async (name: string, payload: unknown) => {
    events.push([name, payload]);
  }) as unknown as MutateDeps["emitter"],
};
const sendDeps = { emitter: deps.emitter as unknown as PostingEmitter };

const limitsWith = (memberOver: Record<string, number> = {}) => ({
  titleMax: 100,
  bodyMax: 50000,
  roles: {
    member: {
      postIntervalSec: 0,
      threadsPerDay: 0,
      uploadsPerDay: 20,
      editWindowSec: 0,
      ...memberOver,
    },
    admin: { postIntervalSec: 0, threadsPerDay: 0, uploadsPerDay: 0, editWindowSec: 0 },
  },
});
async function setLimits(memberOver: Record<string, number> = {}) {
  const v = limitsWith(memberOver) as object;
  await db()
    .insert(siteSettings)
    .values({ key: "limits", value: v, updatedAt: sql`NOW()` })
    .onDuplicateKeyUpdate({ set: { value: v, updatedAt: sql`NOW()` } });
}

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

const postRow = async (id: number) => (await db().select().from(posts).where(eq(posts.id, id)))[0]!;
const threadRow = async (id: number) =>
  (await db().select().from(threads).where(eq(threads.id, id)))[0]!;
const move = (postId: number, to: "visible" | "hidden" | "rejected" | "deleted") =>
  db().transaction(
    (tx) => transitionContent(tx as unknown as DbTx, postId, to, { actorId: DEMO.admin }),
    POINTS_TX_OPTIONS,
  );

async function mkThread(author: Subject, forumId: number, title: string, body = `首帖 ${title}`) {
  const r = await createThread(author, { forumId, title, source: body }, sendDeps);
  if (!r.ok) throw new Error(`准备失败: ${r.code} ${r.message}`);
  return r;
}
async function mkReply(who: Subject, threadId: number, body: string) {
  const r = await createReply(who, { threadId, source: body }, sendDeps);
  if (!r.ok) throw new Error(`准备失败: ${r.code} ${r.message}`);
  return r;
}

describe.skipIf(skipDb)("编辑 / 删除 / 恢复 · 真实 MySQL", () => {
  beforeAll(async () => {
    tdb = await setupTempDb();
    [member, admin, xiaoyi] = await Promise.all([
      loadSubject(DEMO.member),
      loadSubject(DEMO.admin),
      loadSubject(DEMO.xiaoyi),
    ]);
    await setLimits();
  });
  afterAll(async () => {
    await tdb?.teardown();
  });

  it("作者编辑自己的回帖：内容与 edited_at 更新，计数不变，预言机一致；事件 post.edited 不含正文", async () => {
    const t = await mkThread(member, FORUM, "编辑回帖目标");
    const r = await mkReply(xiaoyi, t.threadId, "原文");
    await oracle.reset();
    const f0 = await oracle.forumCounts();
    events.length = 0;
    const res = await editPost(
      xiaoyi,
      { postId: r.postId, source: `改后 ${MARK}`, expectedEditedAt: null },
      deps,
    );
    expect(res).toMatchObject({ ok: true, state: "visible", resubmitted: false });
    const p = await postRow(r.postId);
    expect(p.bodyMd).toContain(MARK);
    expect(p.editedAt).not.toBeNull();
    expect(await oracle.forumCounts()).toEqual(f0);
    await oracle.expectConsistent("编辑回帖后", [t.threadId]);
    expect(events.map((e) => e[0])).toEqual(["post.edited"]);
    expect(JSON.stringify(events)).not.toContain(MARK);
  });

  it("编辑冲突：expectedEditedAt 与当前版本不符 → conflict，内容不变；对照：用正确的版本号可以编辑", async () => {
    const t = await mkThread(member, FORUM, "冲突目标");
    const r = await mkReply(xiaoyi, t.threadId, "冲突原文");
    expect(
      await editPost(
        xiaoyi,
        { postId: r.postId, source: "第一次改", expectedEditedAt: null },
        deps,
      ),
    ).toMatchObject({ ok: true });
    const stale = await editPost(
      xiaoyi,
      { postId: r.postId, source: "拿旧版本号改", expectedEditedAt: null },
      deps,
    );
    expect(stale).toMatchObject({ ok: false, code: "conflict" });
    expect((await postRow(r.postId)).bodyMd).toBe("第一次改");
    const current = (await postRow(r.postId)).editedAt;
    expect(
      await editPost(
        xiaoyi,
        { postId: r.postId, source: "拿当前版本号改", expectedEditedAt: current },
        deps,
      ),
    ).toMatchObject({ ok: true });
    expect((await postRow(r.postId)).bodyMd).toBe("拿当前版本号改");
  });

  it("编辑首帖同时改标题（主题标题与首帖一起）：事件 thread.edited 带保存后的标题", async () => {
    const t = await mkThread(member, FORUM, "旧标题");
    events.length = 0;
    const res = await editPost(
      member,
      { postId: t.postId, source: "新首帖", title: "新标题", expectedEditedAt: null },
      deps,
    );
    expect(res).toMatchObject({ ok: true, kind: "thread" });
    expect((await threadRow(t.threadId)).title).toBe("新标题");
    expect(events).toEqual([
      [
        "thread.edited",
        expect.objectContaining({ threadId: t.threadId, title: "新标题", editorId: AUTHOR }),
      ],
    ]);
    await oracle.expectConsistent("改标题后", [t.threadId]);
  });

  it("驳回后作者修改：转为待审（resubmitted），计数不变，派发 content.submitted；通过审核后计数才加上", async () => {
    const R = await mkForum("编辑审核版", "threads");
    const o = makeOracle(R, [AUTHOR]);
    const t = await mkThread(member, R, "被驳回主题");
    await o.reset([AUTHOR]);
    await move(t.postId, "rejected");
    const f0 = await o.forumCounts();
    events.length = 0;
    const res = await editPost(
      member,
      { postId: t.postId, source: "修改后重新提交", title: "修改后", expectedEditedAt: null },
      deps,
    );
    expect(res).toMatchObject({ ok: true, state: "pending", resubmitted: true });
    expect(await postRow(t.postId)).toMatchObject({ state: "pending" });
    expect((await threadRow(t.threadId)).state).toBe("pending");
    expect(events).toEqual([
      ["content.submitted", expect.objectContaining({ postId: t.postId, isThread: true })],
    ]);
    expect(await o.forumCounts()).toEqual(f0);
    await move(t.postId, "visible");
    expect((await o.forumCounts()).tc).toBe(f0.tc + 1);
    await o.expectConsistent("重提交后通过", [t.threadId], [AUTHOR]);
  });

  it("编辑时限：超出时限的作者编辑被拒（edit_window_closed）；版主不受限；对照：时限内作者可编辑", async () => {
    const t = await mkThread(member, FORUM, "时限目标");
    const r = await mkReply(xiaoyi, t.threadId, "时限原文");
    await setLimits({ editWindowSec: 60 });
    try {
      expect(
        await editPost(
          xiaoyi,
          { postId: r.postId, source: "时限内", expectedEditedAt: null },
          deps,
        ),
      ).toMatchObject({ ok: true });
      await db().execute(
        sql`UPDATE posts SET created_at = NOW() - INTERVAL 600 SECOND WHERE id = ${r.postId}`,
      );
      const cur = (await postRow(r.postId)).editedAt;
      expect(
        await editPost(xiaoyi, { postId: r.postId, source: "超时", expectedEditedAt: cur }, deps),
      ).toMatchObject({
        ok: false,
        code: "edit_window_closed",
      });
      expect((await postRow(r.postId)).bodyMd).toBe("时限内");
      expect(
        await editPost(
          admin,
          { postId: r.postId, source: "版主超时仍可改", expectedEditedAt: cur, reason: "错别字" },
          deps,
        ),
      ).toMatchObject({ ok: true });
    } finally {
      await setLimits();
    }
  });

  it("版主编辑别人的内容：必须填理由，写审计；作者编辑自己的不写审计", async () => {
    const t = await mkThread(member, FORUM, "审计编辑目标");
    const r = await mkReply(xiaoyi, t.threadId, "审计原文");
    expect(
      await editPost(admin, { postId: r.postId, source: "版主改", expectedEditedAt: null }, deps),
    ).toMatchObject({
      ok: false,
      code: "reason_required",
    });
    expect(
      await editPost(
        admin,
        { postId: r.postId, source: "版主改", expectedEditedAt: null, reason: "广告" },
        deps,
      ),
    ).toMatchObject({ ok: true });
    const rows = await db()
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, String(r.postId)));
    expect(rows.map((x) => x.action)).toEqual(["post.edit"]);
    expect(JSON.stringify(rows)).toContain("广告");
    expect(JSON.stringify(rows)).not.toContain("版主改");
    expect(
      await editPost(
        xiaoyi,
        {
          postId: r.postId,
          source: "作者自己改",
          expectedEditedAt: (await postRow(r.postId)).editedAt,
        },
        deps,
      ),
    ).toMatchObject({ ok: true });
    expect(
      (
        await db()
          .select()
          .from(auditLog)
          .where(eq(auditLog.targetId, String(r.postId)))
      ).length,
    ).toBe(1);
  });

  it("门控编辑：有人解锁后，只能改价格；换解锁方式、删除门控都被拒，且不写入", async () => {
    const t = await mkThread(
      member,
      FORUM,
      "门控编辑目标",
      '公开\n\n:::gate{unlock="points" price="5"}\n隐藏甲\n:::',
    );
    const gate = (await db().select().from(postGates).where(eq(postGates.postId, t.postId)))[0]!;
    await db().insert(gateUnlocks).values({
      gateId: gate.id,
      userId: DEMO.xiaoyi,
      pricePaid: 5,
      authorIncome: 4,
      unlockedAt: "2026-10-20 00:00:00",
    });
    const cur = (await postRow(t.postId)).editedAt;
    expect(
      await editPost(
        member,
        {
          postId: t.postId,
          source: '公开\n\n:::gate{unlock="reply"}\n隐藏甲\n:::',
          expectedEditedAt: cur,
        },
        deps,
      ),
    ).toMatchObject({
      ok: false,
      code: "gate_conditions_locked",
    });
    expect(
      await editPost(
        member,
        { postId: t.postId, source: "公开\n\n后文", expectedEditedAt: cur },
        deps,
      ),
    ).toMatchObject({
      ok: false,
      code: "gate_has_unlocks",
    });
    expect((await db().select().from(postGates).where(eq(postGates.postId, t.postId))).length).toBe(
      1,
    );
    expect(
      await editPost(
        member,
        {
          postId: t.postId,
          source: '公开\n\n:::gate{unlock="points" price="9"}\n隐藏乙\n:::',
          expectedEditedAt: cur,
        },
        deps,
      ),
    ).toMatchObject({
      ok: true,
    });
    const g2 = (await db().select().from(postGates).where(eq(postGates.postId, t.postId)))[0]!;
    expect(g2.conditions).toEqual([{ type: "points", price: 9 }]);
    expect(g2.hiddenMd).toContain("隐藏乙");
    expect((await postRow(t.postId)).bodyMd).not.toContain("隐藏乙");
  });

  it("作者删除自己的回帖：计数 -1、预言机一致；事件 post.deleted，byModerator=false，不写审计", async () => {
    const t = await mkThread(member, FORUM, "删回帖目标");
    const r = await mkReply(xiaoyi, t.threadId, "要删的回帖");
    await oracle.reset();
    const f0 = await oracle.forumCounts();
    events.length = 0;
    expect(await deletePost(xiaoyi, { postId: r.postId }, deps)).toMatchObject({
      ok: true,
      kind: "reply",
    });
    expect(await oracle.forumCounts()).toMatchObject({ pc: f0.pc - 1 });
    expect((await postRow(r.postId)).state).toBe("deleted");
    await oracle.expectConsistent("作者删回帖后", [t.threadId]);
    expect(events).toEqual([
      [
        "post.deleted",
        expect.objectContaining({ postId: r.postId, byModerator: false, operatorId: REPLIER }),
      ],
    ]);
    expect(
      (
        await db()
          .select()
          .from(auditLog)
          .where(eq(auditLog.targetId, String(r.postId)))
      ).length,
    ).toBe(0);
  });

  it("删除主题的规则：有别人的回复 → has_replies；只有作者自己的回复 → 允许（计数正确）", async () => {
    const a = await mkThread(member, FORUM, "有别人回复的主题");
    await mkReply(xiaoyi, a.threadId, "别人的回复");
    expect(await deletePost(member, { postId: a.postId }, deps)).toMatchObject({
      ok: false,
      code: "has_replies",
    });
    expect((await postRow(a.postId)).state).toBe("visible");

    const b = await mkThread(member, FORUM, "只有自己回复的主题");
    await mkReply(member, b.threadId, "自己的回复");
    await oracle.reset();
    const f0 = await oracle.forumCounts();
    expect(await deletePost(member, { postId: b.postId }, deps)).toMatchObject({
      ok: true,
      kind: "thread",
    });
    expect(await oracle.forumCounts()).toMatchObject({ tc: f0.tc - 1, pc: f0.pc - 2 }); // 首帖 + 自己的回复
    await oracle.expectConsistent("删只有自己回复的主题后", [b.threadId, a.threadId]);
  });

  it("版主删除别人的回复：必须填理由，写审计，事件 byModerator=true；作者的权限不被冒用", async () => {
    const t = await mkThread(member, FORUM, "版主删目标");
    const r = await mkReply(xiaoyi, t.threadId, "违规回复");
    expect(await deletePost(admin, { postId: r.postId }, deps)).toMatchObject({
      ok: false,
      code: "reason_required",
    });
    expect((await postRow(r.postId)).state).toBe("visible");
    events.length = 0;
    expect(await deletePost(admin, { postId: r.postId, reason: "辱骂" }, deps)).toMatchObject({
      ok: true,
    });
    const rows = await db()
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, String(r.postId)));
    expect(rows.map((x) => x.action)).toEqual(["post.state.deleted"]);
    expect(JSON.stringify(rows)).toContain("辱骂");
    expect(events).toEqual([
      ["post.deleted", expect.objectContaining({ byModerator: true, operatorId: DEMO.admin })],
    ]);
    expect(await deletePost(xiaoyi, { postId: r.postId }, deps)).toMatchObject({
      ok: false,
      code: "already_deleted",
    });
  });

  it("恢复：作者不能自己恢复（forbidden）；版主必须填理由；恢复后计数与指针回到明细重算的结果", async () => {
    const t = await mkThread(member, FORUM, "恢复目标");
    const r = await mkReply(xiaoyi, t.threadId, "待恢复回复");
    await deletePost(xiaoyi, { postId: r.postId }, deps);
    expect(await restorePost(xiaoyi, { postId: r.postId, reason: "我想回来" }, deps)).toMatchObject(
      { ok: false, code: "forbidden" },
    );
    expect(await restorePost(admin, { postId: r.postId, reason: "" }, deps)).toMatchObject({
      ok: false,
      code: "reason_required",
    });
    await oracle.reset();
    const f0 = await oracle.forumCounts();
    events.length = 0;
    expect(await restorePost(admin, { postId: r.postId, reason: "误删" }, deps)).toMatchObject({
      ok: true,
      kind: "reply",
    });
    expect((await postRow(r.postId)).state).toBe("visible");
    expect((await oracle.forumCounts()).pc).toBe(f0.pc + 1);
    await oracle.expectConsistent("恢复后", [t.threadId]);
    expect(events).toEqual([
      [
        "content.moderated",
        expect.objectContaining({ postId: r.postId, action: "restore", operatorId: DEMO.admin }),
      ],
    ]);
  });

  it("已删除的内容作者不能再编辑；对照：可见的内容作者能编辑", async () => {
    const t = await mkThread(member, FORUM, "删后编辑");
    const r = await mkReply(xiaoyi, t.threadId, "删后编辑回复");
    await deletePost(xiaoyi, { postId: r.postId }, deps);
    expect(
      await editPost(
        xiaoyi,
        { postId: r.postId, source: "删了还想改", expectedEditedAt: null },
        deps,
      ),
    ).toMatchObject({
      ok: false,
      code: "already_deleted",
    });
    const alive = await mkReply(xiaoyi, t.threadId, "还在的回复");
    expect(
      await editPost(
        xiaoyi,
        { postId: alive.postId, source: "还能改", expectedEditedAt: null },
        deps,
      ),
    ).toMatchObject({ ok: true });
  });

  it("并发编辑：两人同时拿同一版本号提交 → 恰好一个成功，另一个 conflict", async () => {
    const t = await mkThread(member, FORUM, "并发编辑目标");
    const r = await mkReply(xiaoyi, t.threadId, "并发原文");
    const [a, b] = await Promise.all([
      editPost(xiaoyi, { postId: r.postId, source: "并发甲", expectedEditedAt: null }, deps),
      editPost(
        admin,
        { postId: r.postId, source: "并发乙", expectedEditedAt: null, reason: "并发" },
        deps,
      ),
    ]);
    expect([a, b].filter((x) => x.ok)).toHaveLength(1);
    expect([a, b].filter((x) => !x.ok && x.code === "conflict")).toHaveLength(1);
  });
});
