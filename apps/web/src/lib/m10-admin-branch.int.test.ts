// @vitest-environment node
/** M9/M10 管理服务的分支覆盖补齐：restrictions-admin（already/bad_kind）、poll admin（未授权/不存在）。 */
import { eq } from "drizzle-orm";
import { DEMO, getWebDb, polls, pollOptions, threads } from "@funwind/db";
const db = () => getWebDb();
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { createRestriction, liftRestriction } from "@/lib/authz/restrictions-admin";
import { closePoll, deletePoll, listPollPage } from "@/lib/poll/admin";

let tdb: TempDb;
const ACTOR = { userId: DEMO.admin, via: "admin" as const, ip: null };

beforeAll(async () => {
  tdb = await setupTempDb();
});

afterAll(async () => {
  await tdb?.teardown();
});

describe.skipIf(skipDb)("限制管理分支补齐", () => {
  it("解除不存在的限制 → not_found（结果对象而非抛错）", async () => {
    expect(await liftRestriction(ACTOR, 99999999, "理由")).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("非法 kind → bad_kind", async () => {
    expect(
      await createRestriction(ACTOR, { userId: 90005, kind: "explode", reason: "x", endsAt: null }),
    ).toMatchObject({ ok: false, code: "bad_kind" });
  });
});

describe.skipIf(skipDb)("投票管理分支补齐", () => {
  it("closePoll/deletePoll 不存在的投票 → AdminError 投票不存在", async () => {
    await expect(closePoll(ACTOR, 99999999)).rejects.toMatchObject({ message: "投票不存在" });
    await expect(deletePoll(ACTOR, 99999999)).rejects.toMatchObject({ message: "投票不存在" });
  });

  it("版主作用域：非版主对非所辖投票关闭 → AdminError", async () => {
    // team 是 904 的版主，对 901 的投票无权
    const [t] = (await db().insert(threads).values({
      forumId: 901,
      authorId: DEMO.alice,
      title: "非所辖夹具",
      kind: "poll",
      state: "visible",
      createdAt: "2026-10-26 00:00:00",
      lastPostedAt: "2026-10-26 00:00:00",
    })) as unknown as [{ insertId: number }];
    const threadId = Number(t.insertId);
    const [p] = (await db().insert(polls).values({
      threadId,
      optionLimit: 1,
      resultVisibility: "always",
      voterCount: 0,
      createdBy: DEMO.alice,
      createdAt: "2026-10-26 00:00:00",
    })) as unknown as [{ insertId: number }];
    const pollId = Number(p.insertId);

    const { loadSubject } = await import("@/lib/authz/subject");
    await loadSubject(DEMO.team);
    await expect(
      closePoll({ userId: DEMO.team, via: "admin", ip: null }, pollId),
    ).rejects.toMatchObject({
      message: "你不是该版块的版主",
    });
    await expect(
      deletePoll({ userId: DEMO.team, via: "admin", ip: null }, pollId),
    ).rejects.toMatchObject({
      message: "你不是该版块的版主",
    });

    // 清理
    await db().delete(polls).where(eq(polls.id, pollId));
    await db().delete(threads).where(eq(threads.id, threadId));
  });

  it("pollAdminList：site.admin 视角全站可见", async () => {
    // 直插一个投票（901 公开版块）
    const [t] = (await db().insert(threads).values({
      forumId: 901,
      authorId: DEMO.alice,
      title: "管理列表分支夹具",
      kind: "poll",
      state: "visible",
      createdAt: "2026-10-26 00:00:00",
      lastPostedAt: "2026-10-26 00:00:00",
    })) as unknown as [{ insertId: number }];
    const threadId = Number(t.insertId);
    const [p] = (await db().insert(polls).values({
      threadId,
      optionLimit: 1,
      resultVisibility: "always",
      voterCount: 0,
      createdBy: DEMO.alice,
      createdAt: "2026-10-26 00:00:00",
    })) as unknown as [{ insertId: number }];
    await db()
      .insert(pollOptions)
      .values({
        pollId: Number(p.insertId),
        content: "选项",
        voteCount: 0,
        sortOrder: 0,
      });

    const list = (await listPollPage({ status: "all", page: 1, moderated: null })).items;
    expect(list.some((x) => x.pollId === Number(p.insertId))).toBe(true);

    // 清理
    await db()
      .delete(pollOptions)
      .where(eq(pollOptions.pollId, Number(p.insertId)));
    await db()
      .delete(polls)
      .where(eq(polls.id, Number(p.insertId)));
    await db().delete(threads).where(eq(threads.id, threadId));
  });
});
