import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { gateUnlocks, getWebDb, pointAccounts, postGates, posts, threads } from "@funwind/db";
import { checkPermission } from "@/lib/authz/service";
import type { Subject } from "@/lib/authz/types";
import { buildViewerScope, visiblePredicate } from "@/lib/queries/visibility";
import { evaluateGate } from "./evaluate";
import { parseConditions } from "./parse";
import type { GateFacts, GateMeta, GateStats, GateView } from "./types";

/**
 * 门控读取服务——**隐藏正文（post_gates.hidden_md）的唯一读取点**（硬约定 3b，docs/GATES.md §2）。
 * 读取分两步，从构造上杜绝泄露：
 *   ① 只读元数据（不含 hidden_md）+ 观众事实 → 纯函数判定每个门控；
 *   ② 只对「开放」的门控才去取 hidden_md。锁定的门控，正文根本没有离开数据库。
 * 仓库里另有一个守卫测试（hidden-md-guard.test.ts）断言其他文件不得引用 hidden_md。
 */

export type GateViews = Map<number, Map<string, GateView>>; // postId → gateKey → view

interface PostCtx {
  id: number;
  authorId: number;
}

/** 一个门控的判定结果（元数据 + 观众相对它的开放/锁定结论）。元数据刻意不含 hidden_md */
interface GateDecisionItem {
  meta: GateMeta;
  decision: ReturnType<typeof evaluateGate>;
}

/**
 * 判定一个主题内一批帖子的全部门控（读取侧第 ① 步，**不读 hidden_md**）：
 * 加载门控元数据与观众事实，交给纯函数 evaluateGate。
 * 隐藏正文（resolveViews）与门控附件（openGateIds）共用这一份判定，保证「能看正文的人才能取附件」不会分叉。
 * 调用方须已确认这些帖子对观众可见。
 */
async function decideGates(
  viewer: Subject,
  thread: { id: number; forumId: number },
  postList: readonly PostCtx[],
  onlyGateIds?: ReadonlySet<number>,
): Promise<GateDecisionItem[]> {
  if (postList.length === 0) return [];
  const db = getWebDb();
  const authorOf = new Map(postList.map((p) => [p.id, p.authorId]));

  // ① 元数据：刻意不选 hidden_md
  const rows = await db
    .select({
      id: postGates.id,
      postId: postGates.postId,
      gateKey: postGates.gateKey,
      conditions: postGates.conditions,
      matchMode: postGates.matchMode,
      unlockCount: postGates.unlockCount,
    })
    .from(postGates)
    .where(inArray(postGates.postId, [...authorOf.keys()]))
    .orderBy(postGates.postId, postGates.id);
  const metas: GateMeta[] = rows
    .filter((r) => !onlyGateIds || onlyGateIds.has(r.id))
    .map((r) => ({ ...r, conditions: parseConditions(r.conditions) }));
  if (metas.length === 0) return [];

  const viewerId = viewer.userId;
  const needsPoints = metas.some((m) => m.conditions.some((c) => c.type === "points"));
  const needsReply = metas.some((m) => m.conditions.some((c) => c.type === "reply"));

  const [isModerator, unlockedRows, replied, balanceRows] = await Promise.all([
    checkPermission(viewer, "forum.moderate", { forumId: thread.forumId }).then((d) => d.allowed),
    viewerId !== null && needsPoints
      ? db
          .select({
            gateId: gateUnlocks.gateId,
            unlockedAt: gateUnlocks.unlockedAt,
            pricePaid: gateUnlocks.pricePaid,
          })
          .from(gateUnlocks)
          .where(
            and(
              eq(gateUnlocks.userId, viewerId),
              inArray(
                gateUnlocks.gateId,
                metas.map((m) => m.id),
              ),
            ),
          )
      : Promise.resolve([]),
    // 回复可见：观众在本主题下有一条 visible 回帖（不含首帖）；待审核的不算，免得垃圾回帖即解锁
    viewerId !== null && needsReply
      ? db
          .select({ n: sql<number>`1` })
          .from(posts)
          .where(
            and(
              eq(posts.threadId, thread.id),
              eq(posts.authorId, viewerId),
              gt(posts.floor, 1),
              eq(posts.state, "visible"),
            ),
          )
          .limit(1)
          .then((r) => r.length > 0)
      : Promise.resolve(false),
    viewerId !== null && needsPoints
      ? db
          .select({ balance: pointAccounts.balance })
          .from(pointAccounts)
          .where(eq(pointAccounts.userId, viewerId))
          .limit(1)
      : Promise.resolve([]),
  ]);

  const unlocked = new Map(
    unlockedRows.map((u) => [u.gateId, { unlockedAt: u.unlockedAt, pricePaid: u.pricePaid }]),
  );
  const balance = balanceRows[0]?.balance ?? 0;

  return metas.map((m) => {
    const facts: GateFacts = {
      viewerId,
      isAuthor: viewerId !== null && authorOf.get(m.postId) === viewerId,
      isModerator,
      unlocked,
      hasReplied: replied,
      balance,
    };
    return { meta: m, decision: evaluateGate(m, facts) };
  });
}

/**
 * 观众对一批门控的开放状态（docs/ATTACHMENT-GATES.md §5、§6）：返回**开放**的门控 id 集合，不读隐藏正文。
 * 门控附件据此放行——与隐藏正文共用 decideGates，两条链路因此不会分叉。
 *
 * fail-closed：不在返回集合里的 id 一律视为锁定，包括不存在的门控、属于其他帖子的门控、
 * 以及不属于 `postList` 的门控（decideGates 只加载 postList 内帖子的门控）。
 * 调用方须已确认 `postList` 内的帖子对观众可见。
 */
export async function openGateIds(
  viewer: Subject,
  thread: { id: number; forumId: number },
  postList: readonly PostCtx[],
  gateIds: ReadonlySet<number>,
): Promise<Set<number>> {
  if (gateIds.size === 0) return new Set();
  const decisions = await decideGates(viewer, thread, postList, gateIds);
  return new Set(decisions.filter((d) => d.decision.open).map((d) => d.meta.id));
}

/**
 * 对一个主题内的一批帖子解析其全部门控（含开放门控的隐藏正文）。
 * 调用方须已确认这些帖子对观众可见（页面经 getThreadView / listReplies；单门控出口经 visiblePredicate）。
 */
async function resolveViews(
  viewer: Subject,
  thread: { id: number; forumId: number },
  postList: readonly PostCtx[],
  onlyGateIds?: ReadonlySet<number>,
): Promise<GateViews> {
  const out: GateViews = new Map();
  const decisions = await decideGates(viewer, thread, postList, onlyGateIds);
  if (decisions.length === 0) return out;
  const db = getWebDb();

  // ② 只对开放的门控取正文（唯一读取 hidden_md 的语句）
  const openIds = decisions.filter((d) => d.decision.open).map((d) => d.meta.id);
  const contents = new Map<number, string>();
  if (openIds.length > 0) {
    const hidden = await db
      .select({ id: postGates.id, hiddenMd: postGates.hiddenMd })
      .from(postGates)
      .where(inArray(postGates.id, openIds));
    for (const h of hidden) contents.set(h.id, h.hiddenMd);
  }

  // 作者视图的统计：购买人数与累计收益
  const authorGateIds = decisions
    .filter((d) => d.decision.open && d.decision.reason === "author")
    .map((d) => d.meta.id);
  const stats = new Map<number, GateStats>();
  if (authorGateIds.length > 0) {
    const s = await db
      .select({
        gateId: gateUnlocks.gateId,
        buyers: sql<number>`COUNT(*)`,
        income: sql<number>`COALESCE(SUM(${gateUnlocks.authorIncome}), 0)`,
      })
      .from(gateUnlocks)
      .where(inArray(gateUnlocks.gateId, authorGateIds))
      .groupBy(gateUnlocks.gateId);
    for (const r of s) stats.set(r.gateId, { buyers: Number(r.buyers), income: Number(r.income) });
  }

  for (const { meta, decision } of decisions) {
    const view: GateView = decision.open
      ? {
          gateId: meta.id,
          status: "open",
          reason: decision.reason,
          contentMd: contents.get(meta.id) ?? "",
          pricePaid: decision.pricePaid,
          unlockedAt: decision.unlockedAt,
          stats:
            decision.reason === "author"
              ? (stats.get(meta.id) ?? { buyers: 0, income: 0 })
              : undefined,
        }
      : { gateId: meta.id, status: "locked", prompts: decision.prompts };
    const byKey = out.get(meta.postId) ?? new Map<string, GateView>();
    byKey.set(meta.gateKey, view);
    out.set(meta.postId, byKey);
  }
  return out;
}

/**
 * 页面批量入口：一页的全部门控一次解析，无 N+1。只处理 hasGate 的帖子，无门控的页面零额外查询。
 */
export async function loadGateViews(
  viewer: Subject,
  thread: { id: number; forumId: number },
  postList: readonly { id: number; authorId: number; hasGate: boolean }[],
): Promise<GateViews> {
  return resolveViews(
    viewer,
    thread,
    postList.filter((p) => p.hasGate),
  );
}

export interface GateLocation {
  gateId: number;
  postId: number;
  /** 帖子楼层：首帖为 1（用于计算购买后跳回的页码） */
  floor: number;
  authorId: number;
  threadId: number;
  forumId: number;
}

/**
 * 定位一个门控：它所在的帖子与主题必须对观众可见（版块可读 + 状态矩阵），否则 null。
 * 不读取隐藏正文；getGateContent 与 unlockGate 共用，保证“知道门控 id 也摸不到不可见帖子里的门控”。
 */
export async function locateGate(viewer: Subject, gateId: number): Promise<GateLocation | null> {
  const scope = await buildViewerScope(viewer);
  const found = await getWebDb()
    .select({
      gateId: postGates.id,
      postId: posts.id,
      floor: posts.floor,
      authorId: posts.authorId,
      threadId: threads.id,
      forumId: threads.forumId,
    })
    .from(postGates)
    .innerJoin(posts, eq(posts.id, postGates.postId))
    .innerJoin(threads, eq(threads.id, posts.threadId))
    .where(
      and(
        eq(postGates.id, gateId),
        // 帖子与所属主题都必须对观众可见
        visiblePredicate(
          { forumId: threads.forumId, state: threads.state, authorId: threads.authorId },
          scope,
        ),
        visiblePredicate(
          { forumId: threads.forumId, state: posts.state, authorId: posts.authorId },
          scope,
        ),
      ),
    )
    .limit(1);
  return found[0] ?? null;
}

/**
 * 单门控出口（docs/GATES.md §2）：先确认该门控所在的帖子/主题对观众可见，再判定。
 * 帖子不可见（受限版块、屏蔽、别人的待审核…）或门控不存在 → null。
 */
export async function getGateContent(viewer: Subject, gateId: number): Promise<GateView | null> {
  const f = await locateGate(viewer, gateId);
  if (!f) return null;
  const views = await resolveViews(
    viewer,
    { id: f.threadId, forumId: f.forumId },
    [{ id: f.postId, authorId: f.authorId }],
    new Set([gateId]),
  );
  return [...(views.get(f.postId)?.values() ?? [])][0] ?? null;
}
