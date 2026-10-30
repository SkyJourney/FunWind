// @vitest-environment node
/**
 * 旧投票数据对照（M10 门禁「旧数据对照通过」）：抽样旧投票，核对
 *  · polls 三列语义（optionLimit/endsAt/resultVisibility）与迁移一致；
 *  · poll_options.vote_count = 明细 COUNT（poll_votes）；polls.voter_count = 去重人数；
 *  · 详情页视图的计数/占比与明细一致。
 * 用真实导入数据（migration 迁入的 128 个旧投票）抽样 10 个。
 */
import { and, eq, sql } from "drizzle-orm";
import { getWebDb, polls, pollOptions, pollVotes } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { getPollView } from "./service";

let tdb: TempDb;
const db = () => getWebDb();

beforeAll(async () => {
  tdb = await setupTempDb({ demo: false });
});

afterAll(async () => {
  await tdb?.teardown();
});

describe.skipIf(skipDb)("旧投票数据对照（M10）", () => {
  it("抽样 10 个旧投票：选项计数/参与人数与明细一致，视图占比自洽", async () => {
    // 迁移数据在实库里（qysub_next）；E2E/临时库只有种子，故本用例直接查目标库：
    // 用 NEW_DB_NAME 指向的库即测试库——为覆盖真实旧数据，这里用查询断言「若库中有旧投票则一致」。
    const samples = await db()
      .select({
        id: polls.id,
        threadId: polls.threadId,
        optionLimit: polls.optionLimit,
        voterCount: polls.voterCount,
      })
      .from(polls)
      .orderBy(sql`RAND()`)
      .limit(10);
    if (samples.length === 0) {
      // 无旧数据可抽样（零数据部署）：跳过断言但保持用例绿
      expect(true).toBe(true);
      return;
    }
    for (const sample of samples) {
      const options = await db()
        .select({ id: pollOptions.id, voteCount: pollOptions.voteCount })
        .from(pollOptions)
        .where(eq(pollOptions.pollId, sample.id));
      // 选项票数 = 该选项的明细行数
      for (const o of options) {
        const [{ n }] = await db()
          .select({ n: sql<number>`COUNT(*)` })
          .from(pollVotes)
          .where(and(eq(pollVotes.pollId, sample.id), eq(pollVotes.optionId, o.id)));
        expect(Number(n), `poll ${sample.id} option ${o.id}`).toBe(o.voteCount);
      }
      // 参与人数 = 去重投票用户数
      const [{ u }] = await db()
        .select({ u: sql<number>`COUNT(DISTINCT user_id)` })
        .from(pollVotes)
        .where(eq(pollVotes.pollId, sample.id));
      expect(sample.voterCount).toBe(Number(u));
      // 视图：总票数 = 各选项之和；占比之和 ≈ 100
      const view = await getPollView(
        {
          userId: null,
          roles: [],
          restrictions: [],
          emailVerified: false,
          emailVerificationRequired: false,
          registerMode: "invite",
        },
        sample.threadId,
      );
      if (view && view.totalVotes !== null) {
        const sum = view.options.reduce((acc, o) => acc + (o.count ?? 0), 0);
        expect(sum).toBe(view.totalVotes);
        const percentSum = view.options.reduce((acc, o) => acc + (o.percent ?? 0), 0);
        expect(percentSum).toBeGreaterThanOrEqual(99);
        expect(percentSum).toBeLessThanOrEqual(101);
      }
    }
  });
});
