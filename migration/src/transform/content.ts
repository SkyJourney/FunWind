import type { GateCondition, GateDraft } from "@funwind/content";
import { ubbToMarkdown, type ConvertWarning } from "./ubb.js";
import { toDatetime } from "../config.js";

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

/** 旧站内容的三种状态；只有 visible 会被迁移，其余随旧库归档 */
export type LegacyContentState = "visible" | "hidden" | "deleted";

export interface ThreadRow {
  id: number;
  forumId: number;
  authorId: number;
  title: string;
  prefixId: number | null;
  kind: "normal" | "poll";
  firstPostId: number;
  /** 置顶级别：0 无 / 1 版块 / 2 分区 / 3 全站 */
  pinLevel: number;
  isFeatured: boolean;
  viewCount: number;
  createdAt: string;
}

export interface PostRow {
  id: number;
  threadId: number;
  floor: number;
  authorId: number;
  bodyMd: string;
  replyToPostId: number | null;
  hasGate: boolean;
  createdAt: string;
  editedAt: string | null;
}

export interface GateRow {
  id: number;
  postId: number;
  /** 帖内稳定身份，与正文占位 :::gate{key="…"} 对应 */
  gateKey: string;
  conditions: GateCondition[];
  matchMode: "all" | "any";
  hiddenMd: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContentContext {
  /** 真实存在的用户（state=active）；内容作者不在其中的建占位账号 */
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
}

export interface ContentStats {
  /** 迁移的主题数（每个都有首帖） */
  threads: number;
  /** 未迁移的主题（旧库即归档）；判定顺序：回收站/屏蔽 → 空壳 → 版块不存在 → 无作者 */
  threadsDropped: {
    deleted: number;
    hidden: number;
    spamShell: number;
    /** 版块已被删除或属于回收站子树的 tid */
    badForum: number[];
    noAuthor: number;
  };
  /** 无正文但有回复，补了空首帖 */
  emptyFirstPosts: number[];
  /** 未迁移的回帖；所属主题未迁移的记为 orphan，其余按状态 */
  postsDropped: { orphan: number; deleted: number; hidden: number; noAuthor: number };
  /** 回复指针置空：跨主题 / 指向不存在的帖 / 指向未迁移的帖 */
  replyPointers: { crossThread: number; dangling: number; droppedTarget: number };
  gates: { points: number; reply: number };
  warnings: Map<string, number>;
  /** 需要站长复核的明细（帖子 id + 说明） */
  priceReset: { postId: number; price: string }[];
  unclosedGates: { postId: number; tag: string }[];
  nestedDropped: { postId: number; detail: string }[];
}

export interface ContentResult {
  threads: ThreadRow[];
  /** 按 id 升序：旧回帖保留 pid，首帖 id 排在其后 */
  posts: PostRow[];
  /** 已分配 id（按 (post_id, 帖内序号) 升序自增） */
  gates: GateRow[];
  /** tid → 首帖 post id：点赞、购买、附件的归属解析都靠它 */
  firstPostOf: Map<number, number>;
  /** postId → 该帖正文里每个 `[attachment=N]` 引用所在的门控 key（null = 公开正文）；附件归属门控的依据 */
  attachmentRefs: Map<number, { aid: number; gateKey: string | null }[]>;
  /** 作者不在 userIds 的 uid → 其最早内容时间（占位账号的 created_at） */
  placeholders: Map<number, string>;
  stats: ContentStats;
}

/** 旧 disabled（2 = 回收站）→ deleted；屏蔽 → hidden；其余可见 */
export function stateOf(disabled: number, ifshield: number): LegacyContentState {
  if (Number(disabled) > 0) return "deleted";
  if (Number(ifshield) > 0) return "hidden";
  return "visible";
}

/** 记录「需要占位账号的作者」及其最早内容时间 */
export function noteAuthor(
  seen: Map<number, string>,
  userIds: ReadonlySet<number>,
  uid: number,
  at: string,
): void {
  if (userIds.has(uid)) return;
  const prev = seen.get(uid);
  if (prev === undefined || at < prev) seen.set(uid, at);
}

/** 旧置顶值 0–3 与新级别一致（1 版块 / 2 分区 / 3 全站），越界按边界截断 */
const pinLevelOf = (topped: number): number => Math.min(3, Math.max(0, Number(topped) || 0));

export function transformContent(
  oldThreads: readonly OldThread[],
  oldPosts: readonly OldPost[],
  ctx: ContentContext,
): ContentResult {
  const stats: ContentStats = {
    threads: 0,
    threadsDropped: { deleted: 0, hidden: 0, spamShell: 0, badForum: [], noAuthor: 0 },
    emptyFirstPosts: [],
    postsDropped: { orphan: 0, deleted: 0, hidden: 0, noAuthor: 0 },
    replyPointers: { crossThread: 0, dangling: 0, droppedTarget: 0 },
    gates: { points: 0, reply: 0 },
    warnings: new Map(),
    priceReset: [],
    unclosedGates: [],
    nestedDropped: [],
  };

  const threads: ThreadRow[] = [];
  const posts: PostRow[] = [];
  const firstPostOf = new Map<number, number>();
  const placeholders = new Map<number, string>();
  /** 待分配 id 的门控：全部帖子转换完后按 (postId, 序号) 排序再编号 */
  const pendingGates: { postId: number; draft: GateDraft; createdAt: string; updatedAt: string }[] =
    [];
  const attachmentRefs = new Map<number, { aid: number; gateKey: string | null }[]>();

  const convert = (
    src: string | null,
    postId: number,
    createdAt: string,
    editedAt: string | null,
  ): { md: string; gateCount: number } => {
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
      pendingGates.push({
        postId,
        draft: g,
        createdAt,
        updatedAt: editedAt ?? createdAt,
      });
    }
    if (r.attachmentRefs.length > 0) {
      const keyOfSeq = new Map(r.gates.map((g) => [g.seq, g.key]));
      attachmentRefs.set(
        postId,
        r.attachmentRefs.map((a) => ({
          aid: a.aid,
          gateKey: a.gateSeq === null ? null : (keyOfSeq.get(a.gateSeq) ?? null),
        })),
      );
    }
    return { md: r.md, gateCount: r.gates.length };
  };

  const editedOf = (modifiedTime: number, createdAt: string): string | null => {
    const modified = toDatetime(Number(modifiedTime));
    return modified && modified > createdAt ? modified : null;
  };

  // 首帖 id 接在旧站全部帖子 pid 之后，按 tid 升序自增：与回帖（保留旧 pid，锚点 #p{pid} 已冻结）
  // 永不冲突，也不复用任何已丢弃帖子的 pid；取全部旧帖的最大值，使其与过滤结果无关
  let nextPostId = oldPosts.reduce((m, p) => Math.max(m, Number(p.pid)), 0);

  // ---- 主题与首帖 ----
  const migratedTids = new Set<number>();
  for (const t of [...oldThreads].sort((a, b) => Number(a.tid) - Number(b.tid))) {
    const tid = Number(t.tid);
    const legacyState = stateOf(t.disabled, t.ifshield);
    if (legacyState !== "visible") {
      stats.threadsDropped[legacyState]++;
      continue;
    }
    if (ctx.spamTids.has(tid)) {
      stats.threadsDropped.spamShell++;
      continue;
    }
    const forumId = Number(t.fid);
    if (!ctx.forumIds.has(forumId)) {
      stats.threadsDropped.badForum.push(tid);
      continue;
    }
    const authorId = Number(t.created_userid);
    if (authorId <= 0) {
      stats.threadsDropped.noAuthor++;
      continue;
    }

    const createdAt = toDatetime(Number(t.created_time)) ?? ctx.asOf;
    const fpId = ++nextPostId;
    const editedAt = editedOf(t.modified_time, createdAt);
    threads.push({
      id: tid,
      forumId,
      authorId,
      title: String(t.subject ?? "")
        .trim()
        .slice(0, 255),
      prefixId: ctx.prefixIds.has(Number(t.topic_type)) ? Number(t.topic_type) : null,
      kind: String(t.special) === "poll" ? "poll" : "normal",
      firstPostId: fpId,
      pinLevel: pinLevelOf(t.topped),
      isFeatured: Number(t.digest) > 0,
      viewCount: Number(t.hits) || 0,
      createdAt,
    });
    migratedTids.add(tid);
    firstPostOf.set(tid, fpId);
    stats.threads++;
    noteAuthor(placeholders, ctx.userIds, authorId, createdAt);

    if (!Number(t.has_content)) stats.emptyFirstPosts.push(tid);
    const { md, gateCount } = convert(t.content, fpId, createdAt, editedAt);
    posts.push({
      id: fpId,
      threadId: tid,
      floor: 1,
      authorId,
      bodyMd: md,
      replyToPostId: null,
      hasGate: gateCount > 0,
      createdAt,
      editedAt,
    });
  }

  // ---- 回帖：只迁可见的；按 (created_time, pid) 稳定排序后分配楼层（首帖 = 1，回帖从 2 起，楼层连续）----
  const oldPidThread = new Map<number, number>(); // 旧站全部帖子的 pid → tid，用于区分回复指针的去向
  const kept = new Map<number, OldPost[]>();
  for (const p of oldPosts) {
    const pid = Number(p.pid);
    const tid = Number(p.tid);
    oldPidThread.set(pid, tid);
    if (!migratedTids.has(tid)) {
      stats.postsDropped.orphan++;
      continue;
    }
    const legacyState = stateOf(p.disabled, p.ifshield);
    if (legacyState !== "visible") {
      stats.postsDropped[legacyState]++;
      continue;
    }
    if (Number(p.created_userid) <= 0) {
      stats.postsDropped.noAuthor++;
      continue;
    }
    const list = kept.get(tid) ?? [];
    list.push(p);
    kept.set(tid, list);
  }
  const keptPidThread = new Map<number, number>();
  for (const [tid, list] of kept) for (const p of list) keptPidThread.set(Number(p.pid), tid);

  for (const [tid, list] of [...kept].sort((a, b) => a[0] - b[0])) {
    list.sort(
      (a, b) => Number(a.created_time) - Number(b.created_time) || Number(a.pid) - Number(b.pid),
    );
    for (const [i, p] of list.entries()) {
      const pid = Number(p.pid);
      const authorId = Number(p.created_userid);
      const createdAt = toDatetime(Number(p.created_time)) ?? ctx.asOf;
      const rp = Number(p.rpid);
      let replyTo: number | null = null;
      if (rp > 0) {
        const target = keptPidThread.get(rp);
        if (target === tid) replyTo = rp;
        else if (target !== undefined) stats.replyPointers.crossThread++;
        else if (oldPidThread.has(rp)) stats.replyPointers.droppedTarget++;
        else stats.replyPointers.dangling++;
      }
      const editedAt = editedOf(p.modified_time, createdAt);
      noteAuthor(placeholders, ctx.userIds, authorId, createdAt);
      const { md, gateCount } = convert(p.content, pid, createdAt, editedAt);
      posts.push({
        id: pid,
        threadId: tid,
        floor: i + 2,
        authorId,
        bodyMd: md,
        replyToPostId: replyTo,
        hasGate: gateCount > 0,
        createdAt,
        editedAt,
      });
    }
  }

  posts.sort((a, b) => a.id - b.id);

  // 门控 id：按 (post_id, 帖内序号) 升序自增 1..n，与扫描顺序无关
  pendingGates.sort((a, b) => a.postId - b.postId || a.draft.seq - b.draft.seq);
  const gates: GateRow[] = pendingGates.map((g, i) => ({
    id: i + 1,
    postId: g.postId,
    gateKey: g.draft.key,
    conditions: g.draft.conditions,
    matchMode: g.draft.matchMode,
    hiddenMd: g.draft.hiddenMd,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  }));

  return { threads, posts, gates, firstPostOf, attachmentRefs, placeholders, stats };
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
  unlockedAt: string;
}

/**
 * 旧购买按「帖子」计（pid=0 表示首帖）；新模型按「每个积分门控」计。
 * 同一帖里有多个积分门控时，一次购买展开成每个门控各一条解锁记录。
 * 购买者必须是真实用户（占位账号只给内容作者建，孤儿购买者丢弃）。
 */
export function transformUnlocks(
  buys: readonly OldBuy[],
  gates: readonly GateRow[],
  postIds: ReadonlySet<number>,
  firstPostOf: ReadonlyMap<number, number>,
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
    const target = Number(b.pid) > 0 ? Number(b.pid) : firstPostOf.get(Number(b.tid));
    if (target === undefined || !postIds.has(target)) {
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
  /** 旧站附件 id：只用来关联正文里的 `[attachment=N]` 引用，不写入新库 */
  aid: number;
  postId: number;
  uploaderId: number;
  originalName: string;
  /** 旧站磁盘上的相对路径（attachment/ 之下） */
  sourcePath: string;
  downloads: number;
  createdAt: string;
}

/**
 * 附件挂到所属回帖；pid=0 或回帖未迁移时挂到该主题的首帖；主题未迁移则丢弃。
 * 上传者缺失（uid 0）时记为所挂帖子的作者。
 */
export function transformAttachments(
  rows: readonly OldAttachment[],
  postIds: ReadonlySet<number>,
  firstPostOf: ReadonlyMap<number, number>,
  authorOf: ReadonlyMap<number, number>,
  asOf: string,
): {
  rows: AttachmentDraft[];
  stats: { orphan: number; reattachedToFirstPost: number; uploaderFromPostAuthor: number };
} {
  const stats = { orphan: 0, reattachedToFirstPost: 0, uploaderFromPostAuthor: 0 };
  const out: AttachmentDraft[] = [];
  for (const a of [...rows].sort((x, y) => Number(x.aid) - Number(y.aid))) {
    let target = Number(a.pid) > 0 && postIds.has(Number(a.pid)) ? Number(a.pid) : 0;
    if (!target) {
      const fp = firstPostOf.get(Number(a.tid));
      if (fp !== undefined && postIds.has(fp)) {
        target = fp;
        if (Number(a.pid) > 0) stats.reattachedToFirstPost++;
      }
    }
    if (!target) {
      stats.orphan++;
      continue;
    }
    let uploaderId = Number(a.created_userid);
    if (uploaderId <= 0) {
      uploaderId = authorOf.get(target) ?? 0;
      stats.uploaderFromPostAuthor++;
    }
    out.push({
      aid: Number(a.aid),
      postId: target,
      uploaderId,
      originalName: String(a.name ?? "").slice(0, 255),
      sourcePath: String(a.path ?? "").slice(0, 255),
      downloads: Number(a.hits) || 0,
      createdAt: toDatetime(Number(a.created_time)) ?? asOf,
    });
  }
  return { rows: out, stats };
}

// ---------- 附件 → 门控归属（docs/ATTACHMENT-GATES.md §7）----------

export type AttachmentGateRule = "R1" | "R2" | "R3" | "R4" | "R5";

export interface BoundAttachment extends AttachmentDraft {
  /** 归属的门控（post_gates.id）；null = 公开 */
  gateId: number | null;
}

export interface AttachmentGateStats {
  /** 各规则命中数 */
  rules: Record<AttachmentGateRule, number>;
  /** R4：所在帖有多个门控而附件未被引用，按「最严」归属，列出供站长复核 */
  ambiguous: { postId: number; aid: number; gateId: number }[];
}

/**
 * 门控「严格程度」：付费（价格越高越严）> 回复可见 > 登录后免费解锁（price 0）。
 * 归属有歧义时 fail-closed——宁可多锁，不可少锁。
 */
function strictness(g: GateRow): number {
  const c = g.conditions[0];
  if (c?.type === "points") {
    const price = Number(c.price) || 0;
    return price > 0 ? 1 + price : 0;
  }
  return 0.5; // 回复可见
}

/** 在若干候选门控里取最严的；并列取 id 最大（帖内序号最靠后）者 */
function strictest(candidates: readonly GateRow[]): GateRow {
  return candidates.reduce((best, g) =>
    strictness(g) > strictness(best) || (strictness(g) === strictness(best) && g.id > best.id)
      ? g
      : best,
  );
}

/**
 * 给每个附件定归属门控（规则只存在于迁移适配层，运行时 schema 不认识旧站）：
 *  R5 所在帖没有门控 → 公开
 *  R2 在公开正文里被引用 → 公开（作者有意公开；同时也在门控内引用的，以公开为准——内容本来就已在公开正文暴露）
 *  R1 只在门控内被引用 → 该门控（引用跨多个门控时取最严）
 *  R3 未被引用，所在帖恰好 1 个门控 → 该门控
 *  R4 未被引用，所在帖有多个门控 → 最严的门控（歧义，列入报告复核）
 * 只看「本附件最终所挂的帖子」内的引用：附件被改挂首帖时，别的帖里的引用不算。
 */
export function bindAttachmentGates(
  drafts: readonly AttachmentDraft[],
  refsOfPost: ReadonlyMap<number, readonly { aid: number; gateKey: string | null }[]>,
  gates: readonly GateRow[],
): { rows: BoundAttachment[]; stats: AttachmentGateStats } {
  const gatesOfPost = new Map<number, GateRow[]>();
  for (const g of gates) {
    const list = gatesOfPost.get(g.postId) ?? [];
    list.push(g);
    gatesOfPost.set(g.postId, list);
  }
  const stats: AttachmentGateStats = {
    rules: { R1: 0, R2: 0, R3: 0, R4: 0, R5: 0 },
    ambiguous: [],
  };
  const rows = drafts.map((d): BoundAttachment => {
    const postGates = gatesOfPost.get(d.postId);
    if (!postGates) {
      stats.rules.R5++;
      return { ...d, gateId: null };
    }
    const refs = (refsOfPost.get(d.postId) ?? []).filter((r) => r.aid === d.aid);
    if (refs.some((r) => r.gateKey === null)) {
      stats.rules.R2++;
      return { ...d, gateId: null };
    }
    if (refs.length > 0) {
      const keys = new Set(refs.map((r) => r.gateKey));
      const hit = postGates.filter((g) => keys.has(g.gateKey));
      if (hit.length > 0) {
        stats.rules.R1++;
        return { ...d, gateId: strictest(hit).id };
      }
    }
    if (postGates.length === 1) {
      stats.rules.R3++;
      return { ...d, gateId: postGates[0]!.id };
    }
    const g = strictest(postGates);
    stats.rules.R4++;
    stats.ambiguous.push({ postId: d.postId, aid: d.aid, gateId: g.id });
    return { ...d, gateId: g.id };
  });
  return { rows, stats };
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
