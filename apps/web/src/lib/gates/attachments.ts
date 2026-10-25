import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { attachments, fileUploads, files, getWebDb, postGates, posts, threads } from "@funwind/db";
import { checkPermission } from "@/lib/authz/service";
import { loadSubject } from "@/lib/authz/subject";
import type { Subject } from "@/lib/authz/types";
import type { DbExecutor, DbTx } from "@/lib/audit";
import { extractFileRefs } from "@funwind/content";
import { MAX_ATTACHMENTS_PER_POST, MAX_INLINE_REFS_PER_POST } from "@/lib/uploads/types";
import { sanitizeOriginalName } from "@/lib/uploads/policy";
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
      // 门控必须与附件同属一帖：关联不上（gateKey 为空）即锁定，不沿用 gate id 的开放结论
      r.gateId === null || (r.gateKey !== null && open.has(r.gateId))
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
    .where(and(inArray(attachments.gateId, [...gateIds]), eq(attachments.kind, "download")));
  return new Set(rows.map((r) => r.gateId).filter((x): x is number => x !== null));
}

/* ───────── M6.4d1：保存时登记正文引用与附件 ───────── */

export interface RegisterPostFilesInput {
  postId: number;
  /** 帖子作者：归属校验的对象（版主编辑他人帖子时也按作者校验，而不是按点保存的人） */
  authorId: number;
  /** 公开部分引用的 storage_key */
  publicRefs: readonly string[];
  /** 各门控隐藏正文引用的 storage_key（只含有引用的门控） */
  gateRefs: readonly { key: string; refs: readonly string[] }[];
  /**
   * 作者提交的下载附件：文件、归属门控 key（null = 公开）、展示名。
   * undefined = 本次请求没有附件字段，不改动已有的下载附件（否则旧版本表单编辑会清空附件）；[] = 明确清空。
   */
  attachments?: readonly { fileId: number; gateKey: string | null; name: string }[];
  /** 编辑时：本帖旧正文里已有的引用。不重新校验归属（迁移来的旧图在作者编辑时不得被误拒） */
  priorRefs?: ReadonlySet<string>;
  /** 作者在本帖所在版块是否持有 attachment.upload（事务外由授权快照算出）；新增归属（非旧引用）时必须为真 */
  canUpload: boolean;
}

export type RegisterResult =
  | { ok: true; uploaded: UploadedAttachment[] }
  | {
      ok: false;
      code:
        | "file_missing"
        | "file_not_owned"
        | "attachment_gate_invalid"
        | "attachment_limit"
        | "inline_limit"
        | "upload_forbidden";
      message: string;
    };

const uniq = <T>(xs: readonly T[]): T[] => [...new Set(xs)];

/**
 * 保存帖子时登记正文引用与附件（设计稿 M6.4 §6）。必须在 applyGateDrafts 之后、同一事务内调用（门控行已就绪）。
 *  1. 数量上限；2. 引用的文件必须存在（key 与 fileId 都查库）；
 *  3. 归属：作者须有 file_uploads 记录，或该文件已被本帖引用（旧引用例外，不重新校验）；
 *  4. 附件的门控 key 必须是本帖现存的门控；
 *  5. 重建 inline 行（先删后插，幂等）；download 行按列表增删改（保留 downloads 计数）。
 * 结果由调用方转为 Rollback 错误，本函数只做判定与写入，不抛业务错误。
 */
export async function registerPostFiles(
  tx: DbTx,
  input: RegisterPostFilesInput,
): Promise<RegisterResult> {
  const { postId, authorId } = input;
  const gateRefKeys = input.gateRefs.flatMap((g) => g.refs);
  const inlineKeys = uniq([...input.publicRefs, ...gateRefKeys]);
  if (inlineKeys.length > MAX_INLINE_REFS_PER_POST) {
    return {
      ok: false,
      code: "inline_limit",
      message: `一个帖子最多 ${MAX_INLINE_REFS_PER_POST} 张内联图片`,
    };
  }

  // 1) 文件存在性：正文引用按 storage_key 查，附件按 id 查（附件 id 由客户端提交，必须逐个确认存在）
  const priorKeys = [...(input.priorRefs ?? [])];
  const keysToFetch = uniq([...inlineKeys, ...priorKeys]);
  const keyRows = keysToFetch.length
    ? await tx
        .select({ id: files.id, storageKey: files.storageKey })
        .from(files)
        .where(inArray(files.storageKey, keysToFetch))
    : [];
  const idByKey = new Map(keyRows.map((r) => [r.storageKey, r.id]));
  // 旧正文里本来就失效的引用（未改动）不阻塞编辑：跳过登记；新增的失效引用一律拒绝
  const priorSet = input.priorRefs ?? new Set<string>();
  for (const key of inlineKeys) {
    if (!idByKey.has(key) && !priorSet.has(key))
      return { ok: false, code: "file_missing", message: "图片已失效，请重新上传" };
  }
  const submitted = input.attachments ?? [];
  if (submitted.length > MAX_ATTACHMENTS_PER_POST) {
    return {
      ok: false,
      code: "attachment_limit",
      message: `一个帖子最多 ${MAX_ATTACHMENTS_PER_POST} 个附件`,
    };
  }
  const attachFileIds = uniq(submitted.map((a) => a.fileId));
  if (attachFileIds.length > 0) {
    const rows = await tx
      .select({ id: files.id })
      .from(files)
      .where(inArray(files.id, attachFileIds));
    if (rows.length !== attachFileIds.length) {
      return { ok: false, code: "file_missing", message: "附件已失效，请重新上传" };
    }
  }

  // 2) 归属：已被本帖引用（现有附件行或旧正文）的文件免检；其余必须是作者自己上传过的
  const existing = await tx
    .select({
      id: attachments.id,
      fileId: attachments.fileId,
      gateId: attachments.gateId,
      originalName: attachments.originalName,
      kind: attachments.kind,
    })
    .from(attachments)
    .where(eq(attachments.postId, postId));
  // 旧引用例外的边界：只豁免「该文件的全部附件行都不属于别人的帖子」的文件。
  // 否则购买者可以把别人门控里的图片链接写进自己的旧正文，编辑时借「旧引用」把它登记成公开行（绕过门控）。
  const priorIds = priorKeys.flatMap((k) => (idByKey.has(k) ? [idByKey.get(k)!] : []));
  const priorForeign = new Set<number>();
  if (priorIds.length > 0) {
    const rows = await tx
      .select({ fileId: attachments.fileId, authorId: posts.authorId })
      .from(attachments)
      .innerJoin(posts, eq(posts.id, attachments.postId))
      .where(inArray(attachments.fileId, priorIds));
    for (const r of rows) if (r.authorId !== authorId) priorForeign.add(r.fileId);
  }
  const priorExempt = priorIds.filter((id) => !priorForeign.has(id));
  const exempt = new Set<number>([...existing.map((e) => e.fileId), ...priorExempt]);
  const toCheck = uniq([
    ...inlineKeys.filter((k) => idByKey.has(k)).map((k) => idByKey.get(k)!),
    ...attachFileIds,
  ]).filter((id) => !exempt.has(id));
  if (toCheck.length > 0 && !input.canUpload) {
    return { ok: false, code: "upload_forbidden", message: "你在该版块没有上传权限" };
  }
  if (toCheck.length > 0) {
    const owned = await tx
      .select({ fileId: fileUploads.fileId })
      .from(fileUploads)
      .where(and(eq(fileUploads.userId, authorId), inArray(fileUploads.fileId, toCheck)));
    const ownedSet = new Set(owned.map((o) => o.fileId));
    if (toCheck.some((id) => !ownedSet.has(id))) {
      return { ok: false, code: "file_not_owned", message: "只能引用自己上传的图片或附件" };
    }
  }

  // 3) 门控映射：只读 gate_key 与 id，不读隐藏正文列（硬约定 3b）
  const gateRows = await tx
    .select({ id: postGates.id, gateKey: postGates.gateKey })
    .from(postGates)
    .where(eq(postGates.postId, postId));
  const gateIdByKey = new Map(gateRows.map((g) => [g.gateKey, g.id]));
  for (const a of submitted) {
    if (a.gateKey !== null && !gateIdByKey.has(a.gateKey)) {
      return {
        ok: false,
        code: "attachment_gate_invalid",
        message: "附件归属的门控不存在，请重新选择",
      };
    }
  }

  // 4) 写入：inline 行整体重建（D7：删除门控时其中的内联图行随之清理）
  await tx
    .delete(attachments)
    .where(and(eq(attachments.postId, postId), eq(attachments.kind, "inline")));
  const inlineRows = new Map<string, { fileId: number; gateId: number | null }>();
  for (const key of input.publicRefs) {
    const fileId = idByKey.get(key);
    if (fileId === undefined) continue;
    inlineRows.set(`${fileId}:null`, { fileId, gateId: null });
  }
  for (const g of input.gateRefs) {
    const gateId = gateIdByKey.get(g.key) ?? null;
    for (const key of g.refs) {
      const fileId = idByKey.get(key);
      if (fileId === undefined) continue;
      inlineRows.set(`${fileId}:${gateId}`, { fileId, gateId });
    }
  }
  if (inlineRows.size > 0) {
    await tx.insert(attachments).values(
      [...inlineRows.values()].map((r) => ({
        postId,
        gateId: r.gateId,
        fileId: r.fileId,
        uploaderId: authorId,
        originalName: "",
        kind: "inline" as const,
        createdAt: sql`NOW()`,
      })),
    );
  }

  // 5) download 行：按提交的列表对账（同一文件只留第一条；保留已有行的 downloads 计数）
  if (input.attachments === undefined) return { ok: true, uploaded: [] };
  const desired = new Map<number, { gateId: number | null; name: string }>();
  for (const a of submitted) {
    if (desired.has(a.fileId)) continue;
    desired.set(a.fileId, {
      gateId: a.gateKey === null ? null : gateIdByKey.get(a.gateKey)!,
      name: sanitizeOriginalName(a.name),
    });
  }
  const currentDownloads = existing.filter((e) => e.kind === "download");
  for (const row of currentDownloads) {
    const want = desired.get(row.fileId);
    if (want === undefined) {
      await tx.delete(attachments).where(eq(attachments.id, row.id));
      continue;
    }
    // 归属或展示名变了才写（保留 downloads 计数）
    if (want.gateId !== row.gateId || want.name !== row.originalName) {
      await tx
        .update(attachments)
        .set({ gateId: want.gateId, originalName: want.name })
        .where(eq(attachments.id, row.id));
    }
    desired.delete(row.fileId);
  }
  // 逐条插入以取得每一行的 id（attachment.uploaded 的载荷需要）；附件数量有上限，代价可忽略
  const uploaded: UploadedAttachment[] = [];
  for (const [fileId, d] of desired) {
    const [{ insertId }] = (await tx.insert(attachments).values({
      postId,
      gateId: d.gateId,
      fileId,
      uploaderId: authorId,
      originalName: d.name,
      kind: "download",
      createdAt: sql`NOW()`,
    })) as unknown as [{ insertId: number }];
    uploaded.push({ attachmentId: Number(insertId), fileId, uploaderId: authorId });
  }
  return { ok: true, uploaded };
}

/** 本次保存新建的下载附件（提交后派发 attachment.uploaded 用） */
export interface UploadedAttachment {
  attachmentId: number;
  fileId: number;
  uploaderId: number;
}

/** 提交的下载附件（表单 attachments 字段的一项） */
export interface AttachmentInput {
  fileId: number;
  gateKey: string | null;
  name: string;
}

/**
 * 写入侧入口：从完整源码抽取引用后登记（发主题 / 回帖 / 编辑共用）。
 * 门控隐藏正文只在 @funwind/content 内切出，web 侧拿到的只是 storage_key 列表（硬约定 3b）。
 */
export function registerSourceFiles(
  tx: DbTx,
  input: {
    postId: number;
    authorId: number;
    source: string;
    canUpload: boolean;
    attachments?: readonly AttachmentInput[];
    priorRefs?: ReadonlySet<string>;
  },
): Promise<RegisterResult> {
  const refs = extractFileRefs(input.source);
  return registerPostFiles(tx, {
    postId: input.postId,
    authorId: input.authorId,
    canUpload: input.canUpload,
    publicRefs: refs.publicRefs,
    gateRefs: refs.gateRefs,
    attachments: input.attachments,
    priorRefs: input.priorRefs,
  });
}

/** 编辑页用：本帖全部下载附件（作者 / 版主视角，含门控归属，不含隐藏正文）。调用方须已确认有编辑权限 */
export interface EditableAttachment {
  fileId: number;
  name: string;
  mime: string;
  sizeBytes: number;
  gateKey: string | null;
}

export async function listEditableAttachments(postId: number): Promise<EditableAttachment[]> {
  const rows = await getWebDb()
    .select({
      id: attachments.id,
      fileId: attachments.fileId,
      name: attachments.originalName,
      mime: files.mime,
      sizeBytes: files.sizeBytes,
      gateKey: postGates.gateKey,
    })
    .from(attachments)
    .innerJoin(files, eq(files.id, attachments.fileId))
    .leftJoin(
      postGates,
      and(eq(postGates.id, attachments.gateId), eq(postGates.postId, attachments.postId)),
    )
    .where(and(eq(attachments.postId, postId), eq(attachments.kind, "download")))
    .orderBy(asc(attachments.id));
  return rows.map((r) => ({
    fileId: r.fileId,
    name: r.name,
    mime: r.mime,
    sizeBytes: r.sizeBytes,
    gateKey: r.gateKey,
  }));
}
