// @vitest-environment node
/**
 * 随机操作序列的预言机测试（M6.1 第 4 步·任务 4）：发主题、回帖、编辑、删除、恢复、隐藏、驳回、审核通过。
 * - 单线程 300 步，每 20 步设一个检查点；另跑 6 轮并发，每轮 8 路同时发起；
 * - 检查点三重核对：全库 recountAll 干跑零漂移（增量维护 == 明细重算）、结构完整性为零、
 *   预言机逐版块 / 主题 / 作者比对；
 * - 固定种子：操作序列与目标选择的随机数可复现（并发轮的调度交错由系统决定，但每轮都必须收敛）。
 * 非空断言：每类操作至少成功一次，防止测试空转；任何未预期的抛错直接失败（如死锁）。
 */
import { eq, sql } from "drizzle-orm";
import {
  DEMO,
  findStructuralAnomalies,
  forums,
  getWebDb,
  poolOf,
  recountAll,
  recountDriftTotal,
  siteSettings,
} from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbTx } from "@/lib/audit";
import { invalidateAuthzSnapshot } from "@/lib/authz/snapshot";
import { loadSubject } from "@/lib/authz/subject";
import type { Subject } from "@/lib/authz/types";
import { POINTS_TX_OPTIONS } from "@/lib/points/retry";
import { makeOracle } from "@/test/posting-oracle";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { createReply, createThread, postingRetryStats, type PostingEmitter } from "./service";
import { deletePost, editPost, restorePost, type MutateDeps } from "./mutate";
import { transitionContent } from "./transition";

type OpKind = "newThread" | "reply" | "edit" | "delete" | "restore" | "hide" | "reject" | "approve";

/** 各操作的权重（合计 100）。回帖与新主题最多，保证产生足够的楼层与并发冲突 */
const OP_WEIGHTS: [OpKind, number][] = [
  ["newThread", 15],
  ["reply", 35],
  ["edit", 10],
  ["delete", 9],
  ["restore", 8],
  ["hide", 7],
  ["reject", 7],
  ["approve", 9],
];
const ALL_KINDS = OP_WEIGHTS.map(([k]) => k);

/** 审核类操作：允许的起始状态与目标状态（由版主经 transitionContent 执行） */
const MODERATION: Record<
  "hide" | "reject" | "approve",
  { from: string[]; to: "hidden" | "rejected" | "visible" }
> = {
  hide: { from: ["visible"], to: "hidden" },
  reject: { from: ["pending", "visible"], to: "rejected" },
  approve: { from: ["pending", "rejected", "hidden"], to: "visible" },
};

/** 固定种子的 PRNG（mulberry32），保证操作序列可复现 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(next: () => number, xs: readonly T[]): T | undefined =>
  xs.length > 0 ? xs[Math.floor(next() * xs.length)] : undefined;
const weighted = (next: () => number): OpKind => {
  let x = next() * 100;
  for (const [k, w] of OP_WEIGHTS) {
    if ((x -= w) < 0) return k;
  }
  return "reply";
};

const AUTHORS = [DEMO.member, DEMO.xiaoyi, DEMO.team] as const;
const MODERATOR = DEMO.admin;
const db = () => getWebDb();
const pool = () => poolOf(getWebDb());

let tdb: TempDb;
const subj = new Map<number, Subject>();
let forumIds: number[] = [];
let oracles: ReturnType<typeof makeOracle>[] = [];

const events: [string, unknown][] = [];
const deps: MutateDeps = {
  emitter: (async (name: string, payload: unknown) => {
    events.push([name, payload]);
  }) as unknown as MutateDeps["emitter"],
};
const sendDeps = { emitter: deps.emitter as unknown as PostingEmitter };

/** 原生查询的结果行（列别名与下方 SQL 一致） */
type Row = Record<string, unknown>;
interface ThreadRow {
  id: number;
  forumId: number;
  title: string;
}
interface PostRow {
  id: number;
  threadId: number;
  floor: number;
  authorId: number;
  state: string;
  editedAt: string | null;
  title: string;
}

/** 原生查询：取结果集（与预言机同口径，取第一个元素作为行数组） */
const rows = async <T = Row>(s: ReturnType<typeof sql>): Promise<T[]> =>
  ((await db().execute(s)) as unknown as [T[]])[0] ?? [];

const forumList = () => sql.raw(forumIds.join(","));
const threadsInScope = () =>
  rows<ThreadRow>(
    sql`SELECT id, forum_id AS forumId, title FROM threads WHERE forum_id IN (${forumList()})`,
  );
const postsInScope = () =>
  rows<PostRow>(sql`SELECT p.id, p.thread_id AS threadId, p.floor, p.author_id AS authorId, p.state,
      p.edited_at AS editedAt, t.title
    FROM posts p JOIN threads t ON t.id = p.thread_id
    WHERE t.forum_id IN (${forumList()})`);

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

/** 限制配置；postIntervalSec 由 setPostInterval 按阶段切换 */
const limitsWith = (postIntervalSec: number) => ({
  titleMax: 100,
  bodyMax: 50000,
  roles: {
    member: { postIntervalSec, threadsPerDay: 0, uploadsPerDay: 20, editWindowSec: 0 },
    admin: { postIntervalSec: 0, threadsPerDay: 0, uploadsPerDay: 0, editWindowSec: 0 },
  },
});

/**
 * 切换发帖间隔。间隔大于 0 时，发帖在加锁前会读取作者的最近一帖（enforceFrequency）。
 * 这次读取决定了 RR 下快照何时建立：间隔为 0 时该读取被跳过，RR 的过期读在此测不出来，
 * 所以并发阶段必须开启间隔，才与生产配置（会员默认 5 秒）走同一条路径。
 */
async function setPostInterval(sec: number) {
  const v = limitsWith(sec) as object;
  await db()
    .insert(siteSettings)
    .values({ key: "limits", value: v, updatedAt: sql`NOW()` })
    .onDuplicateKeyUpdate({ set: { value: v, updatedAt: sql`NOW()` } });
}

interface Outcome {
  kind: OpKind;
  /** 操作是否成功（领域上的成功；被拒绝 / 无目标 不算成功，但不算异常） */
  ok: boolean;
  /** 未预期的抛错（应始终为空，死锁等属于此类） */
  error?: unknown;
}

/**
 * 执行一次随机操作。目标从库里现读；随机数全部由 next 提供（并发轮事先抽好，保证序列可复现）。
 * hot 给出时，回帖固定打到该主题（并发轮的热点争用）。
 * 领域拒绝（越权 / 状态不允许 / 冲突）以 ok=false 返回；只有真正的异常才进 error。
 */
async function runOp(
  kind: OpKind,
  tag: string,
  next: () => number,
  hot?: number,
): Promise<Outcome> {
  try {
    switch (kind) {
      case "newThread": {
        const forumId = pick(next, forumIds)!;
        const author = subj.get(pick(next, [...AUTHORS])!)!;
        const r = await createThread(
          author,
          { forumId, title: `主题 ${tag}`, source: `正文 ${tag}` },
          sendDeps,
        );
        return { kind, ok: r.ok };
      }
      case "reply": {
        let threadId = hot;
        if (threadId === undefined) {
          const t = pick(next, await threadsInScope());
          if (!t) return { kind, ok: false };
          threadId = Number(t.id);
        }
        const who = subj.get(pick(next, [...AUTHORS])!)!;
        const r = await createReply(who, { threadId, source: `回复 ${tag}` }, sendDeps);
        return { kind, ok: r.ok };
      }
      case "edit": {
        const p = pick(next, await postsInScope());
        if (!p) return { kind, ok: false };
        const r = await editPost(
          subj.get(Number(p.authorId))!,
          {
            postId: Number(p.id),
            source: `改写 ${tag}`,
            title: Number(p.floor) === 1 ? String(p.title) : undefined,
            expectedEditedAt: p.editedAt ?? null,
          },
          deps,
        );
        return { kind, ok: r.ok };
      }
      case "delete": {
        const p = pick(
          next,
          (await postsInScope()).filter((x) => x.state !== "deleted"),
        );
        if (!p) return { kind, ok: false };
        // 一半由作者删（无理由），一半由版主删（必须带理由）
        const byMod = next() < 0.5;
        const r = byMod
          ? await deletePost(
              subj.get(MODERATOR)!,
              { postId: Number(p.id), reason: `清理 ${tag}` },
              deps,
            )
          : await deletePost(subj.get(Number(p.authorId))!, { postId: Number(p.id) }, deps);
        return { kind, ok: r.ok };
      }
      case "restore": {
        const p = pick(
          next,
          (await postsInScope()).filter((x) => x.state === "deleted"),
        );
        if (!p) return { kind, ok: false };
        const r = await restorePost(
          subj.get(MODERATOR)!,
          { postId: Number(p.id), reason: `恢复 ${tag}` },
          deps,
        );
        return { kind, ok: r.ok };
      }
      case "hide":
      case "reject":
      case "approve": {
        const m = MODERATION[kind];
        const p = pick(
          next,
          (await postsInScope()).filter((x) => m.from.includes(String(x.state))),
        );
        if (!p) return { kind, ok: false };
        const r = await db().transaction(
          (tx) =>
            transitionContent(tx as unknown as DbTx, Number(p.id), m.to, {
              actorId: MODERATOR,
              reason: `审核 ${tag}`,
            }),
          POINTS_TX_OPTIONS,
        );
        return { kind, ok: r.ok };
      }
    }
  } catch (error) {
    return { kind, ok: false, error };
  }
}

/** 检查点：增量 == 明细重算（全库干跑）、结构完整、逐版块预言机 */
async function checkpoint(label: string) {
  const dry = await recountAll(pool(), { dryRun: true });
  const drifted = dry.tables.filter((t) => t.rows + t.created > 0);
  expect(recountDriftTotal(dry), `${label}：增量与明细重算不一致 ${JSON.stringify(drifted)}`).toBe(
    0,
  );
  expect(await findStructuralAnomalies(pool()), `${label}：结构完整性`).toMatchObject({
    orphanPosts: 0,
    orphanThreads: 0,
    orphanPostGates: 0,
    orphanAttachments: 0,
    floorIndexOk: true,
    floorDuplicates: 0,
    firstPostMissing: 0,
    stateMismatch: 0,
  });
  for (const [i, o] of oracles.entries()) {
    const tids = (await threadsInScope())
      .filter((t) => Number(t.forumId) === forumIds[i])
      .map((t) => Number(t.id));
    await o.expectConsistent(`${label}：版块 ${forumIds[i]}`, tids, [...AUTHORS]);
  }
}

describe.skipIf(skipDb)("随机操作序列的预言机测试 · 真实 MySQL", () => {
  beforeAll(async () => {
    tdb = await setupTempDb();
    for (const id of [...AUTHORS, MODERATOR]) subj.set(id, await loadSubject(id));
    await setPostInterval(0);
    // 三个版块：不审核 / 主题审核 / 全部审核，覆盖各种初始状态
    forumIds = [
      await mkForum("随机版·不审", "none"),
      await mkForum("随机版·审主题", "threads"),
      await mkForum("随机版·全审", "all"),
    ];
    oracles = forumIds.map((f) => makeOracle(f, [...AUTHORS]));
    // 基线：演示种子已按明细重算；新版块从零开始，这里再全量重算一次作为起点
    await recountAll(pool());
  });

  afterAll(async () => {
    await tdb?.teardown();
  });

  it("单线程 300 步 + 6 轮 8 路并发：检查点零漂移、结构完整、预言机一致；每类操作都成功过", async () => {
    postingRetryStats.deadlock = 0;
    postingRetryStats.duplicate = 0;
    const kindsOk = new Map<OpKind, number>(ALL_KINDS.map((k) => [k, 0]));
    const unexpected: { round: string; error: unknown }[] = [];
    const record = (o: Outcome, round: string) => {
      if (o.error) unexpected.push({ round, error: o.error });
      else if (o.ok) kindsOk.set(o.kind, (kindsOk.get(o.kind) ?? 0) + 1);
    };

    // ---- 单线程 300 步 ----
    const r = rng(20261025);
    for (let step = 1; step <= 300; step++) {
      const kind = weighted(r);
      record(await runOp(kind, `s${step}`, r), `单线程 ${step}`);
      if (step % 20 === 0) await checkpoint(`单线程第 ${step} 步`);
    }
    await checkpoint("单线程结束");
    expect(unexpected, "单线程出现未预期异常").toEqual([]);

    // ---- 6 轮并发，每轮 8 路：偶数路的回帖全部打到同一热点主题，制造真实的同行争用 ----
    // 开启 1 秒发帖间隔（见 setPostInterval）；每轮前等满 1.1 秒，使每个作者每轮恰好可发一次
    await setPostInterval(1);
    const rc = rng(7070707);
    for (let round = 1; round <= 6; round++) {
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const [hotRow] = await rows<{ id: number }>(sql`SELECT id FROM threads
          WHERE forum_id IN (${forumList()}) AND state = 'visible'
          ORDER BY reply_count DESC, id LIMIT 1`);
      const hot = hotRow ? Number(hotRow.id) : undefined;
      // 先把本轮 8 路操作的随机数全部抽好，保证序列由种子决定
      const plans = Array.from({ length: 8 }, (_, i) => {
        const drawn = weighted(rc);
        const kind: OpKind = i % 2 === 0 ? "reply" : drawn;
        const draws = Array.from({ length: 8 }, () => rc());
        return { kind, tag: `c${round}-${i}`, draws };
      });
      const outs = await Promise.all(
        plans.map((p, i) => {
          let j = 0;
          const next = () => p.draws[j++ % p.draws.length]!;
          return runOp(p.kind, p.tag, next, i % 2 === 0 ? hot : undefined);
        }),
      );
      for (const o of outs) record(o, `并发第 ${round} 轮`);
      expect(unexpected, `并发第 ${round} 轮出现未预期异常（疑似死锁或连接问题）`).toEqual([]);
      await checkpoint(`并发第 ${round} 轮结束`);
    }

    await setPostInterval(0);

    // ---- 重试观测：正确的加锁与隔离下楼层分配不撞键，撞键重试应为零（靠重试兜底即是错的） ----
    console.log(
      `[随机操作] 发帖重试：死锁 ${postingRetryStats.deadlock} / 楼层撞键 ${postingRetryStats.duplicate}`,
    );
    expect(
      postingRetryStats.duplicate,
      "楼层分配出现撞键重试：锁或快照不正确，靠重试才得以收敛",
    ).toBe(0);

    // ---- 非空：每类操作都必须至少成功一次，否则测试在空转 ----
    const scale = await rows(sql`SELECT
          (SELECT COUNT(*) FROM threads WHERE forum_id IN (${forumList()})) AS threads,
          (SELECT COUNT(*) FROM posts p JOIN threads t ON t.id = p.thread_id WHERE t.forum_id IN (${forumList()})) AS posts`);
    console.log(
      `[随机操作] 成功次数 ${JSON.stringify(Object.fromEntries(kindsOk))}；规模 主题 ${scale[0]?.threads} / 帖子 ${scale[0]?.posts}`,
    );
    const missing = ALL_KINDS.filter((k) => !kindsOk.get(k));
    expect(missing, "以下操作从未成功，测试未覆盖").toEqual([]);

    // ---- 重算幂等：全量重算后再跑一次零修正 ----
    const first = await recountAll(pool());
    expect(recountDriftTotal(first)).toBe(0);
    expect(recountDriftTotal(await recountAll(pool()))).toBe(0);
    await checkpoint("重算之后");
  }, 120_000);
});
