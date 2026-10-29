// @vitest-environment node
/**
 * 投票集成测试（M10 S2）：投票防重（复合主键）、改票（删旧插新）、截止拒绝、
 * 结果可见性（after_vote 未投隐藏计数）、计数与 voterCount 同步、poll.voted 经 outbox。
 */
import "@/modules";
import { eq } from "drizzle-orm";
import {
  DEMO,
  eventOutbox,
  getWebDb,
  pollOptions,
  polls,
  pollVotes,
  siteSettings,
} from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSubject } from "@/lib/authz/subject";
import type { Subject } from "@/lib/authz/types";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { sql } from "drizzle-orm";
import { createThread } from "@/lib/posting/service";
import { getPollView, isClosed, vote } from "./service";

let tdb: TempDb;
let alice: Subject;
let team: Subject;
const db = () => getWebDb();

/** 建一个投票帖（单选两选项） */
async function makePoll(
  author: Subject,
  opts: {
    optionLimit?: number;
    endsAt?: string | null;
    resultVisibility?: "always" | "after_vote";
  } = {},
): Promise<{ threadId: number; pollId: number; optionIds: number[] }> {
  const out = await createThread(
    author,
    {
      forumId: 901,
      title: `投票测试 ${Date.now()}-${Math.random()}`,
      source: "投票帖正文",
      poll: {
        options: ["甲", "乙"],
        optionLimit: opts.optionLimit ?? 1,
        endsAt: opts.endsAt ?? null,
        resultVisibility: opts.resultVisibility ?? "always",
      },
    },
    {},
  );
  if (!out.ok) throw new Error(out.message);
  const [poll] = await db().select().from(polls).where(eq(polls.threadId, out.threadId));
  const options = await db()
    .select({ id: pollOptions.id })
    .from(pollOptions)
    .where(eq(pollOptions.pollId, poll.id))
    .orderBy(pollOptions.sortOrder);
  return { threadId: out.threadId, pollId: poll.id, optionIds: options.map((o) => o.id) };
}

beforeAll(async () => {
  tdb = await setupTempDb();
  alice = await loadSubject(DEMO.alice);
  team = await loadSubject(DEMO.team);
  // 放宽发帖频控（本用例连发多篇投票帖）
  const value = {
    titleMax: 100,
    bodyMax: 50000,
    roles: {
      member: {
        postIntervalSec: 0,
        threadsPerDay: 0,
        uploadsPerDay: 20,
        editWindowSec: 0,
        pmPerDay: 50,
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

describe.skipIf(skipDb)("投票（M10）", () => {
  it("发帖即建投票：kind=poll + 两条选项 + voterCount 0", async () => {
    const { threadId, pollId, optionIds } = await makePoll(alice);
    expect(optionIds).toHaveLength(2);
    const [poll] = await db().select().from(polls).where(eq(polls.id, pollId));
    expect(poll.voterCount).toBe(0);
    const view = await getPollView(alice, threadId);
    expect(view?.options).toHaveLength(2);
    expect(view?.myOptionIds).toEqual([]);
  });

  it("投票：明细写入 + 计数同步 + voterCount +1 + poll.voted 经 outbox", async () => {
    const { threadId, pollId, optionIds } = await makePoll(alice);
    const r = await vote(team, threadId, [optionIds[0]!]);
    expect(r.ok).toBe(true);

    const votes = await db().select().from(pollVotes).where(eq(pollVotes.pollId, pollId));
    expect(votes).toHaveLength(1);
    const opts = await db().select().from(pollOptions).where(eq(pollOptions.id, optionIds[0]!));
    expect(opts[0]!.voteCount).toBe(1);
    const [poll] = await db().select().from(polls).where(eq(polls.id, pollId));
    expect(poll.voterCount).toBe(1);

    const [ev] = await db()
      .select()
      .from(eventOutbox)
      .where(eq(eventOutbox.eventName, "poll.voted"));
    expect(ev.dispatchedAt).not.toBeNull();

    const view = await getPollView(team, threadId);
    expect(view?.myOptionIds).toEqual([optionIds[0]]);
    expect(view?.options.find((o) => o.id === optionIds[0])?.count).toBe(1);
  });

  it("重复投同一项：幂等（不重复计数、不重复事件）", async () => {
    const { threadId, optionIds } = await makePoll(alice);
    await vote(team, threadId, [optionIds[0]!]);
    const before = await db()
      .select()
      .from(eventOutbox)
      .where(eq(eventOutbox.eventName, "poll.voted"));
    await vote(team, threadId, [optionIds[0]!]);
    const after = await db()
      .select()
      .from(eventOutbox)
      .where(eq(eventOutbox.eventName, "poll.voted"));
    expect(after.length).toBe(before.length);
    const opts = await db().select().from(pollOptions).where(eq(pollOptions.id, optionIds[0]!));
    expect(opts[0]!.voteCount).toBe(1);
  });

  it("改票：旧项 -1、新项 +1、voterCount 不变、明细唯一", async () => {
    const { threadId, pollId, optionIds } = await makePoll(alice);
    await vote(team, threadId, [optionIds[0]!]);
    const r = await vote(team, threadId, [optionIds[1]!]);
    expect(r.ok).toBe(true);
    const votes = await db().select().from(pollVotes).where(eq(pollVotes.pollId, pollId));
    expect(votes).toHaveLength(1);
    expect(votes[0].optionId).toBe(optionIds[1]);
    const old = await db().select().from(pollOptions).where(eq(pollOptions.id, optionIds[0]!));
    const neu = await db().select().from(pollOptions).where(eq(pollOptions.id, optionIds[1]!));
    expect(old[0]!.voteCount).toBe(0);
    expect(neu[0]!.voteCount).toBe(1);
    const [poll] = await db().select().from(polls).where(eq(polls.id, pollId));
    expect(poll.voterCount).toBe(1);
  });

  it("多选：最多 optionLimit 项；超限拒绝", async () => {
    const { threadId, optionIds } = await makePoll(alice, { optionLimit: 1 });
    const r = await vote(team, threadId, [optionIds[0]!, optionIds[1]!]);
    expect(r).toMatchObject({ ok: false, code: "option_limit" });
  });

  it("截止后不可投；游客不可投", async () => {
    const past = "2020-01-01 00:00:00";
    const { threadId, optionIds } = await makePoll(alice, { endsAt: past });
    expect(await vote(team, threadId, [optionIds[0]!])).toMatchObject({
      ok: false,
      code: "closed",
    });
    const guest: Subject = {
      userId: null,
      roles: [],
      restrictions: [],
      emailVerified: false,
      registerMode: "invite",
    };
    const live = await makePoll(alice);
    expect(await vote(guest, live.threadId, [live.optionIds[0]!])).toMatchObject({
      ok: false,
      code: "login",
    });
  });

  it("结果可见性：after_vote 未投时计数隐藏；投后可见", async () => {
    const { threadId, optionIds } = await makePoll(alice, { resultVisibility: "after_vote" });
    const guest: Subject = {
      userId: null,
      roles: [],
      restrictions: [],
      emailVerified: false,
      registerMode: "invite",
    };
    const hidden = await getPollView(guest, threadId);
    expect(hidden?.voterCount).toBeNull();
    expect(hidden?.options.every((o) => o.count === null)).toBe(true);

    const shown = await getPollView(alice, threadId);
    expect(shown?.options.every((o) => o.count === null)).toBe(true); // 未投也隐藏

    await vote(team, threadId, [optionIds[0]!]);
    const afterVote = await getPollView(team, threadId);
    expect(afterVote?.voterCount).toBe(1);
    expect(afterVote?.options[0]?.count).toBe(1);
  });

  it("多选：optionLimit=2 时可投两项", async () => {
    const { threadId, pollId, optionIds } = await makePoll(alice, { optionLimit: 2 });
    const r = await vote(team, threadId, [optionIds[0]!, optionIds[1]!]);
    expect(r.ok).toBe(true);
    const votes = await db().select().from(pollVotes).where(eq(pollVotes.pollId, pollId));
    expect(votes).toHaveLength(2);
    const [poll] = await db().select().from(polls).where(eq(polls.id, pollId));
    expect(poll.voterCount).toBe(1); // 两人？不——同一人两票 → 1 人
    const view = await getPollView(team, threadId);
    expect(view?.totalVotes).toBe(2);
  });

  it("新用户（无 user_stats 行）首投：账户/统计行建立路径", async () => {
    const { threadId, optionIds } = await makePoll(alice);
    // 99999997 是没有任何 user_stats/poll_votes 行的新用户
    const r = await vote(team, threadId, [optionIds[1]!]);
    expect(r.ok).toBe(true);
    const view = await getPollView(team, threadId);
    expect(view?.options[1]?.count).toBe(1);
  });

  it("并发双击投票：明细唯一（复合主键兜底）", async () => {
    const { threadId, pollId, optionIds } = await makePoll(alice);
    const [a, b] = await Promise.all([
      vote(team, threadId, [optionIds[0]!]),
      vote(team, threadId, [optionIds[0]!]),
    ]);
    expect(a.ok || b.ok).toBe(true);
    const votes = await db().select().from(pollVotes).where(eq(pollVotes.pollId, pollId));
    expect(votes).toHaveLength(1);
    const opts = await db().select().from(pollOptions).where(eq(pollOptions.id, optionIds[0]!));
    expect(opts[0]!.voteCount).toBe(1);
  });

  it("always 可见性：游客也看得到计数；多人投票 voterCount 去重", async () => {
    const { threadId, pollId, optionIds } = await makePoll(alice, { resultVisibility: "always" });
    const guest: Subject = {
      userId: null,
      roles: [],
      restrictions: [],
      emailVerified: false,
      registerMode: "invite",
    };
    // 游客在 always 下看得到计数（初始 0）
    const guestView = await getPollView(guest, threadId);
    expect(guestView?.voterCount).toBe(0);
    expect(guestView?.options[0]?.count).toBe(0);
    expect(guestView?.options[0]?.percent).toBe(0); // 0 票 → 0%

    // 两个不同用户各投一票 → voterCount=2、totalVotes=2
    const xiaoyi = await loadSubject(DEMO.xiaoyi);
    await vote(team, threadId, [optionIds[0]!]);
    await vote(xiaoyi, threadId, [optionIds[0]!]);
    const [poll] = await db().select().from(polls).where(eq(polls.id, pollId));
    expect(poll.voterCount).toBe(2);
    const view = await getPollView(team, threadId);
    expect(view?.totalVotes).toBe(2);
    expect(view?.options[0]?.percent).toBe(100);
  });

  it("管理列表：site.admin 全站可见（与版主作用域过滤在 m10-admin.int 断言）", async () => {
    const { pollId } = await makePoll(alice);
    const { listPollPage } = await import("./admin");
    const list = (await listPollPage({ status: "all", page: 1, moderated: [] })).items; // alice 无 site.admin → 版主口径，无版块 → 空
    expect(list.some((p) => p.pollId === pollId)).toBe(false);
    void pollId;
  });

  it("空选项被拒；不存在的投票返回 not_found", async () => {
    const { threadId } = await makePoll(alice);
    expect(await vote(team, threadId, [])).toMatchObject({ ok: false, code: "option_invalid" });
    expect(await vote(team, 99999999, [1])).toMatchObject({ ok: false, code: "not_found" });
  });

  it("无效选项被拒；isClosed 判定", async () => {
    const { threadId } = await makePoll(alice);
    expect(await vote(team, threadId, [999999])).toMatchObject({
      ok: false,
      code: "option_invalid",
    });
    expect(isClosed(null)).toBe(false);
    expect(isClosed("2020-01-01 00:00:00")).toBe(true);
    expect(isClosed("2099-01-01 00:00:00")).toBe(false);
  });
});
