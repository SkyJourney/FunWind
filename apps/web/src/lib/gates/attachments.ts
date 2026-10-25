import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { attachments, files, getWebDb, postGates, posts, threads } from "@funwind/db";
import { checkPermission } from "@/lib/authz/service";
import { loadSubject } from "@/lib/authz/subject";
import type { Subject } from "@/lib/authz/types";
import type { DbExecutor } from "@/lib/audit";
import { buildViewerScope, visiblePredicate } from "@/lib/queries/visibility";
import { openGateIds } from "./service";

/**
 * 门控附件的**唯一读取出口**（docs/ATTACHMENT-GATES.md，硬约定 3d）。
 * 附件与隐藏正文同权：`attachments.gate_id` 非空时，只有该门控对观众开放才能看到 / 取到它。
 * 判定复用 service.ts 的 `openGateIds`（与隐藏正文同一份判定，两条链路不会分叉）。
 *
 * 安全约定：
 *  · fail-closed——`gate_id` 指向不存在的门控、属于别的帖子的门控，一律锁定（含作者与版主；
 *    这类数据由保存校验与 `db:verify` 的 `integrity:附件门控归属` 保证不会出现）。
 *  · 锁定项在类型上就没有文件名、存储键、大小、下载数，不可能被页面误下发。
 *  · 其他文件不得直接读取 attachments 表（守卫测试 attachments-guard.test.ts）。
 */

/** 观众可取的附件（含展示所需的全部元数据） */
export interface OpenAttachment {
  status: "open";
  id: number;
  postId: number;
  originalName: string;
  downloads: number;
  storageKey: string;
  mime: string;
  sizeBytes: number;
}

/** 被门控锁住的附件：只暴露「存在一个」与它归属的门控 key（门控卡片本来就对观众可见），不含任何文件元数据 */
export interface LockedAttachment {
  status: "locked";
  postId: number;
  /** 归属门控在帖内的 key；门控已不存在（悬空）时为 null */
  gateKey: string | null;
}

export type AttachmentView = OpenAttachment | LockedAttachment;

/**
 * 按帖批量取附件视图（一页的全部帖子一次附件查询 + 至多一次门控判定，无 N+1）。
 * 调用方须已确认 `postList` 内的帖子对观众可见（页面经 getThreadView / listReplies）。
 * 注意 `postList` 不要按 hasGate 预过滤：带 gate_id 的附件落在 has_gate=0 的帖子上也应交给门控判定。
 */
export async function listAttachments(
  viewer: Subject,
  thread: { id: number; forumId: number },
  postList: readonly { id: number; authorId: number }[],
): Promise<Map<number, AttachmentView[]>> {
  const out = new Map<number, AttachmentView[]>();
  if (postList.length === 0) return out;
  const rows = await getWebDb()
    .select({
      id: attachments.id,
      postId: attachments.postId,
      gateId: attachments.gateId,
      gateKey: postGates.gateKey,
      originalName: attachments.originalName,
      downloads: attachments.downloads,
      storageKey: files.storageKey,
      mime: files.mime,
      sizeBytes: files.sizeBytes,
    })
    .from(attachments)
    .innerJoin(files, eq(files.id, attachments.fileId))
    // 只取 gate_key（不涉及隐藏正文列）；门控不存在时为 NULL
    .leftJoin(
      postGates,
      and(eq(postGates.id, attachments.gateId), eq(postGates.postId, attachments.postId)),
    )
    .where(
      and(
        inArray(
          attachments.postId,
          postList.map((p) => p.id),
        ),
        // inline 行是正文里的内联图，不属于帖末附件列表（M6.4）
        eq(attachments.kind, "download"),
      ),
    )
    .orderBy(asc(attachments.id));

  const gateIds = new Set(rows.flatMap((r) => (r.gateId === null ? [] : [r.gateId])));
  const open = await openGateIds(viewer, thread, postList, gateIds);

  for (const r of rows) {
    const view: AttachmentView =
      r.gateId === null || open.has(r.gateId)
        ? {
            status: "open",
            id: r.id,
            postId: r.postId,
            originalName: r.originalName,
            downloads: r.downloads,
            storageKey: r.storageKey,
            mime: r.mime,
            sizeBytes: r.sizeBytes,
          }
        : { status: "locked", postId: r.postId, gateKey: r.gateKey };
    const list = out.get(r.postId) ?? [];
    list.push(view);
    out.set(r.postId, list);
  }
  return out;
}

/** /files 对某个文件的放行结论 */
export type FileGrant =
  /** 图片公开快路径（长缓存）：没有任何附件行，或存在一条未绑门控、所在帖子对游客可见的引用 */
  | { kind: "public" }
  /**
   * 经某条附件行放行，响应只能是私有的（不进共享缓存）。
   * gated=true 表示经门控放行；图片经由「帖子对观众可见」放行时 gated=false，但同样不得公开缓存。
   */
  | { kind: "granted"; attachmentId: number; originalName: string; gated: boolean };

/**
 * 解析观众对某个文件的访问权（/files 用）。无权 → null（调用方一律 404）。
 *
 * 规则（docs/ATTACHMENT-GATES.md §5，M6.4 修订）：
 *  · 图片：没有任何附件行 → 公开；存在一条 gate_id 为空、且所在帖子对**游客**可见的引用 → 公开（长缓存，不论 kind）；
 *    否则必须经某条附件行放行，放行的图片响应一律私有（它依赖于观众能看到哪些帖子）。
 *    图片本身不要求 attachment.download。
 *  · 非图片：必须经某条附件行放行——所在帖子与主题对观众可见、版块持有 attachment.download。
 *  · 附件行绑定了门控的，还要求该门控对观众开放。同一文件被多行引用时，任意一行放行即可。
 * 游客视角的判定单独计算（buildViewerScope(guest)），不能复用观众的 scope，否则会员看得到的受限帖会被当成公开缓存。
 */
export async function resolveFileGrant(
  viewer: Subject,
  file: { id: number; isImage: boolean },
): Promise<FileGrant | null> {
  const db = getWebDb();
  if (file.isImage) {
    const [anyRef] = await db
      .select({ id: attachments.id })
      .from(attachments)
      .where(eq(attachments.fileId, file.id))
      .limit(1);
    if (!anyRef) return { kind: "public" };

    const guestScope = await buildViewerScope(await loadSubject(null));
    const [publicRef] = await db
      .select({ id: attachments.id })
      .from(attachments)
      .innerJoin(posts, eq(posts.id, attachments.postId))
      .innerJoin(threads, eq(threads.id, posts.threadId))
      .where(
        and(
          eq(attachments.fileId, file.id),
          isNull(attachments.gateId),
          visiblePredicate(
            { forumId: threads.forumId, state: threads.state, authorId: threads.authorId },
            guestScope,
          ),
          visiblePredicate(
            { forumId: threads.forumId, state: posts.state, authorId: posts.authorId },
            guestScope,
          ),
        ),
      )
      .limit(1);
    if (publicRef) return { kind: "public" };
  }

  const scope = await buildViewerScope(viewer);
  const candidates = await db
    .select({
      attachmentId: attachments.id,
      originalName: attachments.originalName,
      gateId: attachments.gateId,
      postId: posts.id,
      postAuthorId: posts.authorId,
      threadId: threads.id,
      forumId: threads.forumId,
    })
    .from(attachments)
    .innerJoin(posts, eq(posts.id, attachments.postId))
    .innerJoin(threads, eq(threads.id, posts.threadId))
    .where(
      and(
        eq(attachments.fileId, file.id),
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
    .orderBy(attachments.id);

  const downloadAllowed = new Map<number, boolean>();
  for (const c of candidates) {
    if (!file.isImage) {
      if (!downloadAllowed.has(c.forumId)) {
        downloadAllowed.set(
          c.forumId,
          (await checkPermission(viewer, "attachment.download", { forumId: c.forumId })).allowed,
        );
      }
      if (!downloadAllowed.get(c.forumId)) continue;
    }
    if (c.gateId !== null) {
      const open = await openGateIds(
        viewer,
        { id: c.threadId, forumId: c.forumId },
        [{ id: c.postId, authorId: c.postAuthorId }],
        new Set([c.gateId]),
      );
      if (!open.has(c.gateId)) continue;
    }
    return {
      kind: "granted",
      attachmentId: c.attachmentId,
      originalName: c.originalName,
      gated: c.gateId !== null,
    };
  }
  return null;
}

/** 下载计数 +1：只能在鉴权通过、真正取内容的 GET 之后调用 */
export async function recordDownload(attachmentId: number): Promise<void> {
  await getWebDb()
    .update(attachments)
    .set({ downloads: sql`${attachments.downloads} + 1` })
    .where(eq(attachments.id, attachmentId));
}

/**
 * 这些门控里，哪些还有附件挂在名下（`attachments.gate_id`）。门控写入器删除门控前用它拦截：
 * 删掉门控却留着附件行，读取侧会把悬空归属当锁定（安全，但附件从此没人拿得到）；
 * 若反过来把附件改成公开则是泄露。所以删除门控必须先让作者重新指派附件（M6.4 的交互），此处只负责拒绝。
 */
export async function gatesWithAttachments(
  executor: DbExecutor,
  gateIds: readonly number[],
): Promise<Set<number>> {
  if (gateIds.length === 0) return new Set();
  const rows = await executor
    .selectDistinct({ gateId: attachments.gateId })
    .from(attachments)
    .where(inArray(attachments.gateId, [...gateIds]));
  return new Set(rows.map((r) => r.gateId).filter((x): x is number => x !== null));
}
