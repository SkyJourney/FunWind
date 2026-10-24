import type { GateCondition } from "@funwind/content";
import { ubbToMarkdown, type ConvertWarning } from "./ubb.js";
import { toDatetime } from "../config.js";

/**
 * 首帖的 post id = FIRST_POST_BASE + tid。
 * 旧站首帖只在 threads_content 里，没有 pid；回帖保留旧 pid（锚点 #p{pid} 已冻结，最大 40887），
 * 首帖取一段不会与回帖冲突的确定性 id，重跑结果一致。
 */
export const FIRST_POST_BASE = 100_000;
export const firstPostId = (tid: number): number => FIRST_POST_BASE + tid;

export interface OldThread {
  tid: number;
  fid: number;
  topic_type: number;
  subject: string;
  digest: number;
  topped: number;
  special: string | number | null;
  disabled: number;
  ifshield: number;
  hits: number;
  created_time: number;
  created_username: string | null;
  created_userid: number;
  modified_time: number;
  content: string | null;
  has_content: number;
}

export interface OldPost {
  pid: number;
  tid: number;
  rpid: number;
  disabled: number;
  ifshield: number;
  content: string | null;
  created_time: number;
  created_username: string | null;
  created_userid: number;
  modified_time: number;
}

export type ContentState = "visible" | "hidden" | "deleted" | "spam";

export interface ThreadRow {
  id: number;
  forumId: number;
  authorId: number;
  authorNameLegacy: string | null;
  title: string;
  prefixId: number | null;
  kind: "normal" | "poll";
  firstPostId: number | null;
  state: ContentState;
  topped: number;
  digest: number;
  viewCount: number;
  createdAt: string;
}

export interface PostRow {
  id: number;
  threadId: number;
  floor: number;
  authorId: number;
  authorNameLegacy: string | null;
  bodyMd: string;
  replyToPostId: number | null;
  hasGate: boolean;
  state: ContentState;
  createdAt: string;
  editedAt: string | null;
}

export interface GateRow {
  id: number;
  postId: number;
  seq: number;
  conditions: GateCondition[];
  matchMode: "all" | "any";
  hiddenMd: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContentContext {
  userIds: ReadonlySet<number>;
  forumIds: ReadonlySet<number>;
  prefixIds: ReadonlySet<number>;
  spamTids: ReadonlySet<number>;
  emojiIds: ReadonlySet<number>;
  /** 旧站内部上传路径（p_w_upload/ 之后）→ 已登记文件的 /files 地址；文件不存在返回 null */
  resolveUpload: (rel: string) => string | null;
  /** [attachment=N] → 已登记文件的 /files 地址；image 表示内联为图片 */
  resolveAttachment: (aid: number) => { name: string; url: string; image?: boolean } | null;
  asOf: string;
  /** 版块已被删除的主题改挂到该归档版块（回收站，仅管理员可读）；缺省则丢弃 */
  fallbackForumId?: number;
}

export interface ContentStats {
  threads: number;
  spamThreads: number;
  droppedThreadsBadForum: number[];
  /** 原版块已不存在、改挂到归档版块的主题 */
  reassignedThreads: { tid: number; fromForum: number }[];
  /** 无正文但有回复，补了空首帖 */
  emptyFirstPosts: number[];
  orphanPosts: number;
  crossThreadReplyPointers: number;
  danglingReplyPointers: number;
  postsByState: Record<ContentState, number>;
  gates: { points: number; reply: number };
  warnings: Map<string, number>;
  /** 需要站长复核的明细（帖子 id + 说明） */
  priceReset: { postId: number; price: string }[];
  unclosedGates: { postId: number; tag: string }[];
  nestedDropped: { postId: number; detail: string }[];
}

export interface ContentResult {
  threads: ThreadRow[];
  posts: PostRow[];
  gates: GateRow[];
  stats: ContentStats;
}

/** 旧 disabled（2 = 回收站）→ deleted；屏蔽 → hidden；其余可见 */
export function stateOf(disabled: number, ifshield: number): ContentState {
  if (Number(disabled) > 0) return "deleted";
  if (Number(ifshield) > 0) return "hidden";
  return "visible";
}

const legacyName = (name: string | null, authorId: number, userIds: ReadonlySet<number>) =>
  userIds.has(authorId)
    ? null
    : String(name ?? "")
        .trim()
        .slice(0, 64) || null;

export function transformContent(
  oldThreads: readonly OldThread[],
  oldPosts: readonly OldPost[],
  ctx: ContentContext,
): ContentResult {
  const stats: ContentStats = {
    threads: 0,
    spamThreads: 0,
    droppedThreadsBadForum: [],
    reassignedThreads: [],
    emptyFirstPosts: [],
    orphanPosts: 0,
    crossThreadReplyPointers: 0,
    danglingReplyPointers: 0,
    postsByState: { visible: 0, hidden: 0, deleted: 0, spam: 0 },
    gates: { points: 0, reply: 0 },
    warnings: new Map(),
    priceReset: [],
    unclosedGates: [],
    nestedDropped: [],
  };

  const threads: ThreadRow[] = [];
  const posts: PostRow[] = [];
  const gates: GateRow[] = [];

  const convert = (src: string | null, postId: number): { md: string; gateCount: number } => {
    const r = ubbToMarkdown(src, {
      emojiIds: ctx.emojiIds,
      resolveUpload: ctx.resolveUpload,
      resolveAttachment: ctx.resolveAttachment,
    });
    for (const w of r.warnings) collectWarning(stats, postId, w);
    for (const g of r.gates) {
      const c = g.conditions[0]?.type;
      if (c === "points") stats.gates.points++;
      else if (c === "reply") stats.gates.reply++;
      gates.push({
        id: postId * 16 + g.seq, // 临时：R3-4 改为确定顺序自增
        postId,
        seq: g.seq,
        conditions: g.conditions,
        matchMode: g.matchMode,
        hiddenMd: g.hiddenMd,
        createdAt: ctx.asOf,
        updatedAt: ctx.asOf,
      });
    }
    return { md: r.md, gateCount: r.gates.length };
  };

  // ---- 主题与首帖 ----
  const migratedTids = new Set<number>();
  for (const t of [...oldThreads].sort((a, b) => Number(a.tid) - Number(b.tid))) {
    const tid = Number(t.tid);
    let forumId = Number(t.fid);
    if (!ctx.forumIds.has(forumId)) {
      if (ctx.fallbackForumId === undefined) {
        stats.droppedThreadsBadForum.push(tid);
        continue;
      }
      stats.reassignedThreads.push({ tid, fromForum: forumId });
      forumId = ctx.fallbackForumId;
    }
    const isSpam = ctx.spamTids.has(tid);
    const state: ContentState = isSpam ? "spam" : stateOf(t.disabled, t.ifshield);
    const createdAt = toDatetime(Number(t.created_time)) ?? ctx.asOf;
    const authorId = Number(t.created_userid);
    const fpId = isSpam ? null : firstPostId(tid);

    threads.push({
      id: tid,
      forumId,
      authorId,
      authorNameLegacy: legacyName(t.created_username, authorId, ctx.userIds),
      title: String(t.subject ?? "")
        .trim()
        .slice(0, 255),
      prefixId: ctx.prefixIds.has(Number(t.topic_type)) ? Number(t.topic_type) : null,
      kind: String(t.special) === "poll" ? "poll" : "normal",
      firstPostId: fpId,
      state,
      topped: Number(t.topped) || 0,
      digest: Number(t.digest) || 0,
      viewCount: Number(t.hits) || 0,
      createdAt,
    });
    migratedTids.add(tid);
    stats.threads++;
    if (isSpam) {
      stats.spamThreads++;
      continue;
    }

    if (!Number(t.has_content)) stats.emptyFirstPosts.push(tid);
    const { md, gateCount } = convert(t.content, fpId!);
    const modified = toDatetime(Number(t.modified_time));
    posts.push({
      id: fpId!,
      threadId: tid,
      floor: 1,
      authorId,
      authorNameLegacy: legacyName(t.created_username, authorId, ctx.userIds),
      bodyMd: md,
      replyToPostId: null,
      hasGate: gateCount > 0,
      state,
      createdAt,
      editedAt: modified && modified > createdAt ? modified : null,
    });
    stats.postsByState[state]++;
  }

  // ---- 回帖：按 (created_time, pid) 稳定排序后分配楼层（首帖 = 1，回帖从 2 起）----
  const byThread = new Map<number, OldPost[]>();
  for (const p of oldPosts) {
    const tid = Number(p.tid);
    if (!migratedTids.has(tid) || ctx.spamTids.has(tid)) {
      stats.orphanPosts++;
      continue;
    }
    const list = byThread.get(tid) ?? [];
    list.push(p);
    byThread.set(tid, list);
  }
  const replyPids = new Map<number, number>(); // pid → tid
  for (const [tid, list] of byThread) for (const p of list) replyPids.set(Number(p.pid), tid);

  for (const [tid, list] of [...byThread].sort((a, b) => a[0] - b[0])) {
    list.sort(
      (a, b) => Number(a.created_time) - Number(b.created_time) || Number(a.pid) - Number(b.pid),
    );
    for (const [i, p] of list.entries()) {
      const pid = Number(p.pid);
      const authorId = Number(p.created_userid);
      const createdAt = toDatetime(Number(p.created_time)) ?? ctx.asOf;
      const state = stateOf(p.disabled, p.ifshield);
      const rp = Number(p.rpid);
      let replyTo: number | null = null;
      if (rp > 0) {
        const target = replyPids.get(rp);
        if (target === tid) replyTo = rp;
        else if (target === undefined) stats.danglingReplyPointers++;
        else stats.crossThreadReplyPointers++;
      }
      const { md, gateCount } = convert(p.content, pid);
      const modified = toDatetime(Number(p.modified_time));
      posts.push({
        id: pid,
        threadId: tid,
        floor: i + 2,
        authorId,
        authorNameLegacy: legacyName(p.created_username, authorId, ctx.userIds),
        bodyMd: md,
        replyToPostId: replyTo,
        hasGate: gateCount > 0,
        state,
        createdAt,
        editedAt: modified && modified > createdAt ? modified : null,
      });
      stats.postsByState[state]++;
    }
  }

  return { threads, posts, gates, stats };
}

function collectWarning(stats: ContentStats, postId: number, w: ConvertWarning): void {
  stats.warnings.set(w.code, (stats.warnings.get(w.code) ?? 0) + 1);
  if (w.code === "gate-price-reset") stats.priceReset.push({ postId, price: w.detail ?? "" });
  else if (w.code === "gate-unclosed") stats.unclosedGates.push({ postId, tag: w.detail ?? "" });
  else if (w.code === "gate-nested-dropped")
    stats.nestedDropped.push({ postId, detail: w.detail ?? "" });
}

// ---------- 购买记录 → 解锁记录 ----------

export interface OldBuy {
  tid: number;
  pid: number;
  created_userid: number;
  created_time: number;
  cost: number;
}

export interface UnlockRow {
  gateId: number;
  userId: number;
  pricePaid: number;
  authorIncome: number;
  source: "migrated";
  unlockedAt: string;
}

/**
 * 旧购买按「帖子」计（pid=0 表示首帖）；新模型按「每个积分门控」计。
 * 同一帖里有多个积分门控时，一次购买展开成每个门控各一条解锁记录。
 */
export function transformUnlocks(
  buys: readonly OldBuy[],
  gates: readonly GateRow[],
  postIds: ReadonlySet<number>,
  userIds: ReadonlySet<number>,
  asOf: string,
): {
  rows: UnlockRow[];
  stats: {
    orphanTarget: number;
    replyOnly: number;
    noGate: number;
    orphanBuyer: number;
    duplicate: number;
  };
} {
  const pointsGatesOfPost = new Map<number, GateRow[]>();
  for (const g of gates) {
    if (g.conditions[0]?.type !== "points") continue;
    const list = pointsGatesOfPost.get(g.postId) ?? [];
    list.push(g);
    pointsGatesOfPost.set(g.postId, list);
  }
  const anyGateOfPost = new Set(gates.map((g) => g.postId));
  const stats = { orphanTarget: 0, replyOnly: 0, noGate: 0, orphanBuyer: 0, duplicate: 0 };
  const seen = new Set<string>();
  const rows: UnlockRow[] = [];

  for (const b of buys) {
    const target = Number(b.pid) > 0 ? Number(b.pid) : firstPostId(Number(b.tid));
    if (!postIds.has(target)) {
      stats.orphanTarget++;
      continue;
    }
    if (!userIds.has(Number(b.created_userid))) {
      stats.orphanBuyer++;
      continue;
    }
    const targetGates = pointsGatesOfPost.get(target);
    if (!targetGates) {
      // 目标帖只有「回复可见」门控：旧站把回复解锁也记入购买表（费用 0）；
      // 新模型里回复可见按实际回帖实时判定，不需要解锁记录
      if (anyGateOfPost.has(target)) stats.replyOnly++;
      else stats.noGate++;
      continue;
    }
    for (const g of targetGates) {
      const key = `${g.id}:${b.created_userid}`;
      if (seen.has(key)) {
        stats.duplicate++;
        continue;
      }
      seen.add(key);
      const cost = Number(b.cost) || 0;
      rows.push({
        gateId: g.id,
        userId: Number(b.created_userid),
        pricePaid: cost,
        authorIncome: cost,
        source: "migrated",
        unlockedAt: toDatetime(Number(b.created_time)) ?? asOf,
      });
    }
  }
  return { rows, stats };
}

// ---------- 附件 ----------

export interface OldAttachment {
  aid: number;
  tid: number;
  pid: number;
  name: string;
  type: string;
  size: number;
  hits: number;
  width: number;
  height: number;
  path: string;
  created_userid: number;
  created_time: number;
}

/** 附件草稿：文件本体由文件管线登记（得到 file_id 后才能写 attachments 行） */
export interface AttachmentDraft {
  postId: number;
  uploaderId: number;
  originalName: string;
  /** 旧站磁盘上的相对路径（attachment/ 之下） */
  sourcePath: string;
  downloads: number;
  createdAt: string;
}

/** 附件挂到所属回帖；pid=0 或回帖已不存在时挂到该主题的首帖；主题不存在则丢弃 */
export function transformAttachments(
  rows: readonly OldAttachment[],
  postIds: ReadonlySet<number>,
  asOf: string,
): { rows: AttachmentDraft[]; stats: { orphan: number; reattachedToFirstPost: number } } {
  const stats = { orphan: 0, reattachedToFirstPost: 0 };
  const out: AttachmentDraft[] = [];
  for (const a of [...rows].sort((x, y) => Number(x.aid) - Number(y.aid))) {
    let target = Number(a.pid) > 0 && postIds.has(Number(a.pid)) ? Number(a.pid) : 0;
    if (!target) {
      const fp = firstPostId(Number(a.tid));
      if (Number(a.tid) > 0 && postIds.has(fp)) {
        target = fp;
        if (Number(a.pid) > 0) stats.reattachedToFirstPost++;
      }
    }
    if (!target) {
      stats.orphan++;
      continue;
    }
    out.push({
      postId: target,
      uploaderId: Number(a.created_userid) || 0,
      originalName: String(a.name ?? "").slice(0, 255),
      sourcePath: String(a.path ?? "").slice(0, 255),
      downloads: Number(a.hits) || 0,
      createdAt: toDatetime(Number(a.created_time)) ?? asOf,
    });
  }
  return { rows: out, stats };
}

// ---------- 标签 ----------

export interface TagTransform {
  tags: { id: number; name: string }[];
  threadTags: { threadId: number; tagId: number }[];
  stats: { emptyOrDuplicate: number; orphanRelations: number };
}

export function transformTags(
  tags: readonly { tag_id: number; tag_name: string }[],
  relations: readonly { tag_id: number; param_id: number; type_id: number }[],
  threadIds: ReadonlySet<number>,
): TagTransform {
  const stats = { emptyOrDuplicate: 0, orphanRelations: 0 };
  const names = new Set<string>();
  const kept = new Map<number, string>();
  for (const t of [...tags].sort((a, b) => Number(a.tag_id) - Number(b.tag_id))) {
    const name = String(t.tag_name ?? "")
      .trim()
      .slice(0, 64);
    if (!name || names.has(name)) {
      stats.emptyOrDuplicate++;
      continue;
    }
    names.add(name);
    kept.set(Number(t.tag_id), name);
  }
  const seen = new Set<string>();
  const threadTags: TagTransform["threadTags"] = [];
  for (const r of relations) {
    // type_id = 1 为主题标签（旧库实测只有这一种）
    if (Number(r.type_id) !== 1) continue;
    const key = `${r.param_id}:${r.tag_id}`;
    if (!kept.has(Number(r.tag_id)) || !threadIds.has(Number(r.param_id)) || seen.has(key)) {
      stats.orphanRelations++;
      continue;
    }
    seen.add(key);
    threadTags.push({ threadId: Number(r.param_id), tagId: Number(r.tag_id) });
  }
  return {
    tags: [...kept].map(([id, name]) => ({ id, name })),
    threadTags,
    stats,
  };
}
