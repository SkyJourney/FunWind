import { sql } from "drizzle-orm";
import { getWebDb } from "@funwind/db";
import { expect } from "vitest";

/**
 * 写路径的预言机（M6.1）：缓存列必须等于从明细重算的结果。
 * 口径与迁移的 countersStep 完全一致。仅供集成测试使用。
 * makeOracle(forumId, defaultAuthors) 绑定一个版块：所有重算与断言只作用于它。
 */
export const at = (n: number) => `2026-10-21 10:${String(n).padStart(2, "0")}:00`;

const q = async (s: ReturnType<typeof sql>) =>
  ((await getWebDb().execute(s)) as unknown as [Record<string, unknown>[]])[0];

export function makeOracle(forumId: number, defaultAuthors: number[]) {
  /** 把版块、主题与作者的缓存列设为明细重算的结果。只在造数据后调用 */
  async function reset(authors: number[] = defaultAuthors) {
    await q(sql`UPDATE threads t SET
        reply_count = (SELECT COUNT(*) FROM posts p WHERE p.thread_id = t.id AND p.floor > 1 AND p.state = 'visible'),
        last_post_id = (SELECT p.id FROM posts p WHERE p.thread_id = t.id AND p.state = 'visible' ORDER BY p.floor DESC LIMIT 1),
        last_poster_id = (SELECT p.author_id FROM posts p WHERE p.thread_id = t.id AND p.state = 'visible' ORDER BY p.floor DESC LIMIT 1),
        last_posted_at = COALESCE((SELECT p.created_at FROM posts p WHERE p.thread_id = t.id AND p.state = 'visible' ORDER BY p.floor DESC LIMIT 1), t.created_at)
      WHERE t.forum_id = ${forumId}`);
    await q(sql`UPDATE forums f SET
        thread_count = (SELECT COUNT(*) FROM threads t WHERE t.forum_id = f.id AND t.state = 'visible'),
        post_count = (SELECT COUNT(*) FROM posts p JOIN threads t ON t.id = p.thread_id WHERE t.forum_id = f.id AND t.state = 'visible' AND p.state = 'visible'),
        last_post_id = (SELECT t.last_post_id FROM threads t WHERE t.forum_id = f.id AND t.state = 'visible' ORDER BY t.last_posted_at DESC, t.id DESC LIMIT 1),
        last_posted_at = (SELECT t.last_posted_at FROM threads t WHERE t.forum_id = f.id AND t.state = 'visible' ORDER BY t.last_posted_at DESC, t.id DESC LIMIT 1)
      WHERE f.id = ${forumId}`);
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
      sql`SELECT thread_count tc, post_count pc, last_post_id lp FROM forums WHERE id = ${forumId}`,
    );
    return { tc: Number(r!.tc), pc: Number(r!.pc), lp: r!.lp === null ? null : Number(r!.lp) };
  };

  const userCounts = async (u: number) => {
    const [r] = await q(
      sql`SELECT thread_count tc, post_count pc, featured_count fc, last_post_at lpa FROM user_stats WHERE user_id = ${u}`,
    );
    return { tc: Number(r!.tc), pc: Number(r!.pc), fc: Number(r!.fc), lpa: r!.lpa ?? null };
  };

  /** 预言机断言：版块、主题、作者的缓存列都等于明细重算 */
  async function expectConsistent(label: string, threadIds: number[], authors = defaultAuthors) {
    const f = await forumCounts();
    const [fe] = await q(sql`SELECT
        (SELECT COUNT(*) FROM threads t WHERE t.forum_id = ${forumId} AND t.state = 'visible') tc,
        (SELECT COUNT(*) FROM posts p JOIN threads t ON t.id = p.thread_id WHERE t.forum_id = ${forumId} AND t.state = 'visible' AND p.state = 'visible') pc,
        (SELECT t.last_post_id FROM threads t WHERE t.forum_id = ${forumId} AND t.state = 'visible' ORDER BY t.last_posted_at DESC, t.id DESC LIMIT 1) lp`);
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

  return { reset, forumCounts, userCounts, expectConsistent };
}
