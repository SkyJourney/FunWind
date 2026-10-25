import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { getWebDb, posts, threads } from "@funwind/db";
import { splitSource, type GateDraft } from "@funwind/content";
import { type DbTx } from "@/lib/audit";
import { evaluate } from "@/lib/authz/evaluator";
import { getAuthzSnapshot } from "@/lib/authz/snapshot";
import type { AuthzSnapshot, Subject } from "@/lib/authz/types";
import { applyGateDrafts, type GatePermissions } from "@/lib/gates/write";
import {
  registerSourceFiles,
  type AttachmentInput,
  type UploadedAttachment,
} from "@/lib/gates/attachments";
import { limitsFor } from "@/lib/limits/load";
import { replaceThreadTags, resolveTagIds } from "@/lib/interact/tags";
import { resolveMentionUserIds } from "@/lib/posting/mentions";
import type { ResolvedLimits } from "@/lib/limits/config";
import { POINTS_TX_OPTIONS, isDeadlock } from "@/lib/points/retry";
import { isDuplicateKey } from "@/lib/auth/register";
import {
  dispatchOutboxRows,
  enqueueEventInTx,
  sweepPending,
  type EnqueuedEvent,
  type OutboxEmitter,
} from "@/lib/events/outbox";
import type { EventPayloads } from "@/modules/kernel/types";
import { applyCounterDelta } from "./transition";
import { counterDelta } from "./counters";
import { lockForum, lockThread, lockUserStats } from "./locks";
import {
  IDEMPOTENCY_WINDOW_SEC,
  dailyQuotaExceeded,
  initialState,
  intervalViolated,
} from "./policy";
import { checkBody, checkTitle } from "./text";

/**
 * 创建主题与回帖（M6.1 第 4 步）。
 *
 * 分工：事务外只做"能不能写"的判断（权限快照、限制配置、文本与门控语法）；事务内持锁后再做需要事实的判断
 * （配额与间隔要在持有作者统计行的锁时做，否则并发请求可以绕过上限；主题的锁定与状态要在锁后重读）。
 * 事务内绝不再借第二条连接（连接池只有 8 条，见 lib/points/apply.ts），所以快照与限制都在事务外取好。
 *
 * 加锁顺序：作者 user_stats → 主题 → 版块（与 transition.ts 一致）。事件只在提交之后派发，失败只记日志。
 */

export type PostingErrorCode =
  | "forbidden" // 无权在该版块发帖（含禁言 / 封禁 / 归档 / 分区）；入口层应对外表现为 404
  | "forum_not_found"
  | "not_found" // 主题或帖子不存在
  | "thread_closed" // 主题不是可见状态，不能回帖
  | "thread_locked" // 主题已锁定，且没有 thread.replyLocked
  | "title_empty"
  | "title_too_long"
  | "body_empty"
  | "body_too_long"
  | "gate_syntax"
  | "gate_permission"
  | "too_frequent"
  | "quota_exceeded"
  | "reply_target_invalid"
  | "conflict" // 数据在两次读取之间被并发改变（如主题被移动、编辑冲突），拒绝在过期的判断上写入，请用户刷新后重试
  | "has_replies" // 主题已有别人的回复，作者不能删
  | "already_deleted"
  | "bad_state" // 当前状态下不允许这个动作
  | "thread_gone" // 所属主题已隐藏 / 删除
  | "edit_window_closed" // 超出作者可自行编辑的时限
  | "reason_required" // 版主操作必须填理由
  | "reason_too_long"
  | "not_restorable"
  | "gate_has_unlocks"
  | "file_missing" // 引用或附件的文件已失效（删除或从未落盘），请重新上传
  | "file_not_owned" // 只能引用自己上传过的图片或附件
  | "attachment_gate_invalid" // 附件归属的门控不存在于本帖
  | "attachment_limit"
  | "tag_denied" // 新建标签需要 tag.add，当前用户只能挂已有标签
  | "tag_too_many" // 标签数量超过上限
  | "inline_limit"
  | "upload_forbidden" // 无 attachment.upload 权限却要新增图片或附件
  | "gate_conditions_locked"
  | "gate_has_attachments";

export interface PostingError {
  ok: false;
  code: PostingErrorCode;
  /** 面向用户的说明（不含正文与内部判定细节） */
  message: string;
}

export interface PostingOk {
  ok: true;
  threadId: number;
  postId: number;
  floor: number;
  state: "visible" | "pending";
  /** true = 命中幂等窗口，返回的是已有的帖子，本次没有写入 */
  duplicate: boolean;
}

export type PostingResult = PostingOk | PostingError;

export type PostingEmitter = <K extends "thread.created" | "thread.replied" | "content.submitted">(
  name: K,
  payload: EventPayloads[K],
) => Promise<unknown>;

export interface PostingDeps {
  /** 事件派发（单测注入；缺省走内核总线——快路径 source="posting"，补派 source="outbox"） */
  emitter?: PostingEmitter;
}

export const err = (code: PostingErrorCode, message: string): PostingError => ({
  ok: false,
  code,
  message,
});

/** 事务内遇到业务拒绝时抛出，让事务整体回滚；外层把它还原成结果 */
export class Rollback extends Error {
  constructor(readonly result: PostingError) {
    super(result.code);
  }
}

/**
 * 发帖重试的累计次数（仅供测试观测）。正确的加锁与隔离下，楼层撞键重试本不应发生：
 * 撞键一旦出现，说明楼层分配依赖了重试兜底，而非锁与快照的正确性（随机预言机测试据此断言为零）。
 */
export const postingRetryStats = { deadlock: 0, duplicate: 0 };

/**
 * 发帖事务的重试：死锁（整体回滚后重放是安全的）与唯一键撞车（uq_posts_thread_floor，楼层并发分配的最后一道防线）各重试一次。
 * 正常情况下加锁已经避免了撞车，所以重试很少发生；它存在是为了让一次偶发的竞争不变成 500（设计稿 §4）。
 */
export async function withPostingRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= 2 || !(isDeadlock(e) || isDuplicateKey(e))) throw e;
      if (isDeadlock(e)) postingRetryStats.deadlock++;
      else postingRetryStats.duplicate++;
    }
  }
}

export interface PreparedBody {
  body: string;
  publicMd: string;
  gates: GateDraft[];
}

/** 事务外：正文长度与门控语法（不碰数据库） */
export function prepareBody(source: string, bodyMax: number): PreparedBody | PostingError {
  const b = checkBody(source, bodyMax);
  if (!b.ok) return err(b.code, b.message);
  const split = splitSource(b.value);
  if (split.errors.length > 0) {
    return err("gate_syntax", split.errors.map((e) => e.message).join("；"));
  }
  return { body: b.value, publicMd: split.publicMd, gates: split.gates };
}

export const isError = (x: unknown): x is PostingError =>
  typeof x === "object" && x !== null && (x as PostingError).ok === false;

export function gatePermissions(
  viewer: Subject,
  forumId: number,
  snap: AuthzSnapshot,
): GatePermissions {
  return {
    points: evaluate(viewer, "gate.points", { forumId }, snap).allowed,
    reply: evaluate(viewer, "gate.reply", { forumId }, snap).allowed,
  };
}

/** 发帖间隔与每日主题配额。须在持有作者统计行的锁时调用 */
async function enforceFrequency(
  tx: DbTx,
  authorId: number,
  limits: ResolvedLimits,
  creatingThread: boolean,
): Promise<void> {
  if (limits.postIntervalSec > 0) {
    const [last] = await tx
      .select({ age: sql<number>`TIMESTAMPDIFF(SECOND, ${posts.createdAt}, NOW())` })
      .from(posts)
      .where(eq(posts.authorId, authorId))
      .orderBy(desc(posts.createdAt))
      .limit(1);
    if (intervalViolated(last ? Number(last.age) : null, limits.postIntervalSec)) {
      throw new Rollback(err("too_frequent", `发帖间隔需不少于 ${limits.postIntervalSec} 秒`));
    }
  }
  if (creatingThread && limits.threadsPerDay > 0) {
    const [c] = await tx
      .select({ n: sql<number>`COUNT(*)` })
      .from(threads)
      .where(and(eq(threads.authorId, authorId), gte(threads.createdAt, sql`CURDATE()`)));
    if (dailyQuotaExceeded(Number(c?.n ?? 0), limits.threadsPerDay)) {
      throw new Rollback(err("quota_exceeded", `今日发主题已达上限（${limits.threadsPerDay} 个）`));
    }
  }
}

export interface CreateThreadInput {
  forumId: number;
  title: string;
  /** 完整源码（可含 :::gate 门控围栏） */
  source: string;
  /** 下载附件（表单 attachments 字段解析后的结果） */
  attachments?: readonly AttachmentInput[];
  /** 主题标签（名称，去重由 service 完成）；新标签的创建须 canAddTags */
  tags?: readonly string[];
  canAddTags?: boolean;
}

export async function createThread(
  viewer: Subject,
  input: CreateThreadInput,
  deps: PostingDeps = {},
): Promise<PostingResult> {
  if (viewer.userId === null) return err("forbidden", "请先登录");
  const authorId = viewer.userId;
  const snap = await getAuthzSnapshot();
  const { forumId } = input;
  if (!snap.tree.has(forumId)) return err("forum_not_found", "版块不存在");

  // —— 事务外：权限、限制、文本 ——
  const write = evaluate(viewer, "forum.write", { forumId }, snap);
  // 上传权限在事务外算出（纯内存快照），登记新附件时使用
  const canUpload = evaluate(viewer, "attachment.upload", { forumId }, snap).allowed;
  if (!write.allowed) return err("forbidden", write.reason);
  const isModerator = evaluate(viewer, "forum.moderate", { forumId }, snap).allowed;
  const limits = await limitsFor(viewer, forumId);
  const title = checkTitle(input.title, limits.titleMax);
  if (!title.ok) return err(title.code, title.message);
  const body = prepareBody(input.source, limits.bodyMax);
  if (isError(body)) return body;
  const perms = gatePermissions(viewer, forumId, snap);
  const state = initialState(snap.tree.reviewPolicy(forumId).value, "thread", isModerator);

  // —— 事务内：持锁后做需要事实的判断 ——
  let uploads: UploadedAttachment[] = [];
  let enqueued: EnqueuedEvent[] = [];
  try {
    const out = await withPostingRetry(() =>
      getWebDb().transaction(async (tx): Promise<PostingOk> => {
        // 每次尝试都从空开始：上一次被回滚的尝试不得把它的附件与事件带进派发
        uploads = [];
        enqueued = [];
        await lockUserStats(tx, authorId);
        await lockForum(tx, forumId);

        // 幂等先于频控：双击 / 重试的第二次请求应得到已创建的主题，而不是「发帖太频繁」。
        // 只认仍然有效（可见 / 待审）的主题：作者自删后的同内容新帖不是重复
        const [dup] = await tx
          .select({ threadId: threads.id, postId: threads.firstPostId, state: threads.state })
          .from(threads)
          .innerJoin(posts, eq(posts.id, threads.firstPostId))
          .where(
            and(
              eq(threads.authorId, authorId),
              eq(threads.forumId, forumId),
              eq(threads.title, title.value),
              eq(posts.bodyMd, body.publicMd),
              inArray(threads.state, ["visible", "pending"]),
              gte(threads.createdAt, sql`NOW() - INTERVAL ${IDEMPOTENCY_WINDOW_SEC} SECOND`),
            ),
          )
          .limit(1);
        if (dup?.postId) {
          return {
            ok: true,
            threadId: dup.threadId,
            postId: dup.postId,
            floor: 1,
            state: dup.state as "visible" | "pending",
            duplicate: true,
          };
        }

        await enforceFrequency(tx, authorId, limits, true);

        const [t] = (await tx.insert(threads).values({
          forumId,
          authorId,
          title: title.value,
          state,
          createdAt: sql`NOW()`,
          lastPostedAt: sql`NOW()`,
        })) as unknown as [{ insertId: number }];
        const threadId = Number(t.insertId);
        const [p] = (await tx.insert(posts).values({
          threadId,
          floor: 1,
          authorId,
          bodyMd: body.publicMd,
          hasGate: body.gates.length > 0,
          state,
          createdAt: sql`NOW()`,
        })) as unknown as [{ insertId: number }];
        const postId = Number(p.insertId);
        await tx.update(threads).set({ firstPostId: postId }).where(eq(threads.id, threadId));

        // 标签（M8）：写 thread_tags；新标签须 canAddTags（tag.add）
        if (input.tags !== undefined) {
          const tagRes = await resolveTagIds(tx, input.tags, input.canAddTags === true);
          if (!tagRes.ok) {
            throw new Rollback(
              err(tagRes.code, tagRes.code === "tag_denied" ? "无权创建新标签" : "标签数量超限"),
            );
          }
          await replaceThreadTags(tx, threadId, tagRes.tagIds);
        }

        // @提及（M8）：仅 visible 发（待审内容对被提及者不可见——与 thread.replied 的状态门控同口径）；
        // 上限 10 人（正文可携带数千 @，逐人事件+通知是炸弹面）
        const mentionIds =
          state === "visible" ? await resolveMentionUserIds(tx, body.publicMd, authorId) : [];
        for (const mentionedUserId of mentionIds.slice(0, 10)) {
          enqueued.push(
            await enqueueEventInTx(
              tx,
              "post.mentioned",
              { postId, authorId, mentionedUserId },
              { actorId: authorId, source: "posting" },
            ),
          );
        }

        const gateRes = await applyGateDrafts(tx, postId, body.gates, perms);
        if (!gateRes.ok) throw new Rollback(err("gate_permission", gateRes.error.message));
        const reg = await registerSourceFiles(tx, {
          postId,
          authorId,
          // 与拆分门控用的是同一份规范化源码（prepareBody），两者必须对同一文本得出同样的引用
          source: body.body,
          attachments: input.attachments,
          canUpload,
        });
        if (!reg.ok) throw new Rollback(err(reg.code, reg.message));
        uploads = reg.uploaded;

        const [created] = await tx
          .select({ at: posts.createdAt })
          .from(posts)
          .where(eq(posts.id, postId));
        await applyCounterDelta(
          tx,
          {
            threadId,
            forumId,
            threadCreatedAt: created!.at,
            postId,
            authorId,
            postCreatedAt: created!.at,
          },
          counterDelta({
            kind: "thread",
            before: null,
            after: state,
            threadVisible: true,
            visibleReplies: 0,
            isFeatured: false,
            isLatest: true,
          }),
        );
        // outbox（M7）：与业务同事务登记——提交成功则事件必在，崩溃由补派兜底
        enqueued.push(
          await enqueueEventInTx(
            tx,
            state === "visible" ? "thread.created" : "content.submitted",
            state === "visible"
              ? { threadId, postId, forumId, authorId, title: title.value }
              : { postId, threadId, authorId, forumId, isThread: true },
            { actorId: authorId, source: "posting" },
          ),
        );
        for (const u of uploads) {
          enqueued.push(
            await enqueueEventInTx(
              tx,
              "attachment.uploaded",
              { attachmentId: u.attachmentId, fileId: u.fileId, uploaderId: authorId },
              { actorId: authorId, source: "posting" },
            ),
          );
        }
        return { ok: true, threadId, postId, floor: 1, state, duplicate: false };
      }, POINTS_TX_OPTIONS),
    );
    // 快路径：派发并标记；失败留在 outbox，捎带巡检顺手补一小批积压
    await dispatchOutboxRows(enqueued, {
      emitter: deps.emitter ? (deps.emitter as unknown as OutboxEmitter) : undefined,
    });
    await sweepPending();
    return out;
  } catch (e) {
    if (e instanceof Rollback) return e.result;
    throw e;
  }
}

export interface CreateReplyInput {
  threadId: number;
  source: string;
  /** 指向同一主题里一条可见帖子（引用回复）；缺省为普通回复 */
  replyToPostId?: number | null;
  /** 下载附件（表单 attachments 字段解析后的结果） */
  attachments?: readonly AttachmentInput[];
}

export async function createReply(
  viewer: Subject,
  input: CreateReplyInput,
  deps: PostingDeps = {},
): Promise<PostingResult> {
  if (viewer.userId === null) return err("forbidden", "请先登录");
  const authorId = viewer.userId;
  const snap = await getAuthzSnapshot();

  // —— 事务外：主题探测、权限、限制、文本 ——
  const [probe] = await getWebDb()
    .select({ forumId: threads.forumId, state: threads.state, isLocked: threads.isLocked })
    .from(threads)
    .where(eq(threads.id, input.threadId));
  if (!probe) return err("not_found", "主题不存在");
  const { forumId } = probe;
  const base = evaluate(viewer, "forum.write", { forumId }, snap);
  // 上传权限在事务外算出（纯内存快照），登记新附件时使用
  const canUpload = evaluate(viewer, "attachment.upload", { forumId }, snap).allowed;
  if (!base.allowed) return err("forbidden", base.reason);
  if (probe.isLocked) {
    const locked = evaluate(viewer, "forum.write", { forumId, threadLocked: true }, snap);
    if (!locked.allowed) return err("thread_locked", "主题已锁定，不能回复");
  }
  const isModerator = evaluate(viewer, "forum.moderate", { forumId }, snap).allowed;
  const limits = await limitsFor(viewer, forumId);
  const body = prepareBody(input.source, limits.bodyMax);
  if (isError(body)) return body;
  const perms = gatePermissions(viewer, forumId, snap);
  const state = initialState(snap.tree.reviewPolicy(forumId).value, "reply", isModerator);
  const replyTo = input.replyToPostId ?? null;

  // —— 事务内 ——
  let uploads: UploadedAttachment[] = [];
  let enqueued: EnqueuedEvent[] = [];
  let replyToAuthorId: number | undefined;
  try {
    const out = await withPostingRetry(() =>
      getWebDb().transaction(async (tx): Promise<PostingOk> => {
        // 每次尝试都从空开始：上一次被回滚的尝试不得把它的附件与事件带进派发
        uploads = [];
        enqueued = [];
        replyToAuthorId = undefined;
        await lockUserStats(tx, authorId);
        const thread = await lockThread(tx, input.threadId);
        if (!thread) throw new Rollback(err("not_found", "主题不存在"));
        // 事务外的判断（权限、审核策略、门控权限）都是按 probe.forumId 算的；锁后版块变了则这些结论全部过期，必须拒绝
        if (thread.forumId !== forumId) {
          throw new Rollback(err("conflict", "主题已被移动，请刷新后重试"));
        }
        if (thread.state !== "visible") throw new Rollback(err("thread_closed", "主题不可回复"));
        // 锁后重读：锁定状态可能已被并发改变，以库里的为准
        const gate = evaluate(
          viewer,
          "forum.write",
          { forumId, threadLocked: thread.isLocked },
          snap,
        );
        if (!gate.allowed) {
          throw new Rollback(
            thread.isLocked
              ? err("thread_locked", "主题已锁定，不能回复")
              : err("forbidden", gate.reason),
          );
        }
        await lockForum(tx, thread.forumId);

        // 幂等：同作者、同主题、同正文，窗口内已存在 → 返回它
        const [dup] = await tx
          .select({ id: posts.id, floor: posts.floor, state: posts.state })
          .from(posts)
          .where(
            and(
              eq(posts.threadId, thread.id),
              eq(posts.authorId, authorId),
              eq(posts.bodyMd, body.publicMd),
              // 只认仍然有效的回帖：作者自删后的同内容回复不是重复
              inArray(posts.state, ["visible", "pending"]),
              gte(posts.createdAt, sql`NOW() - INTERVAL ${IDEMPOTENCY_WINDOW_SEC} SECOND`),
            ),
          )
          .limit(1);
        if (dup) {
          return {
            ok: true,
            threadId: thread.id,
            postId: dup.id,
            floor: dup.floor,
            state: dup.state as "visible" | "pending",
            duplicate: true,
          };
        }

        // 频控在幂等之后：重复的请求已在上面返回，这里只拦真正的新回复
        await enforceFrequency(tx, authorId, limits, false);

        if (replyTo !== null) {
          const [target] = await tx
            .select({ id: posts.id, authorId: posts.authorId })
            .from(posts)
            .where(
              and(eq(posts.id, replyTo), eq(posts.threadId, thread.id), eq(posts.state, "visible")),
            );
          if (!target) throw new Rollback(err("reply_target_invalid", "引用的回帖不存在或不可见"));
          // thread.replied 的载荷在事务内补齐（outbox 行必须携带完整载荷，见 enqueueEventInTx）
          replyToAuthorId = target.authorId;
        }

        const [maxRow] = await tx
          .select({ m: sql<number | null>`MAX(${posts.floor})` })
          .from(posts)
          .where(eq(posts.threadId, thread.id));
        const floor = Number(maxRow?.m ?? 0) + 1;

        const [p] = (await tx.insert(posts).values({
          threadId: thread.id,
          floor,
          authorId,
          bodyMd: body.publicMd,
          replyToPostId: replyTo,
          hasGate: body.gates.length > 0,
          state,
          createdAt: sql`NOW()`,
        })) as unknown as [{ insertId: number }];
        const postId = Number(p.insertId);

        // @提及（M8）：仅 visible 发（待审不可见）；上限 10 人
        const replyMentionIds =
          state === "visible" ? await resolveMentionUserIds(tx, body.publicMd, authorId) : [];
        for (const mentionedUserId of replyMentionIds.slice(0, 10)) {
          enqueued.push(
            await enqueueEventInTx(
              tx,
              "post.mentioned",
              { postId, authorId, mentionedUserId },
              { actorId: authorId, source: "posting" },
            ),
          );
        }

        const gateRes = await applyGateDrafts(tx, postId, body.gates, perms);
        if (!gateRes.ok) throw new Rollback(err("gate_permission", gateRes.error.message));
        const reg = await registerSourceFiles(tx, {
          postId,
          authorId,
          // 与拆分门控用的是同一份规范化源码（prepareBody），两者必须对同一文本得出同样的引用
          source: body.body,
          attachments: input.attachments,
          canUpload,
        });
        if (!reg.ok) throw new Rollback(err(reg.code, reg.message));
        uploads = reg.uploaded;

        const [created] = await tx
          .select({ at: posts.createdAt })
          .from(posts)
          .where(eq(posts.id, postId));
        await applyCounterDelta(
          tx,
          {
            threadId: thread.id,
            forumId: thread.forumId,
            threadCreatedAt: created!.at,
            postId,
            authorId,
            postCreatedAt: created!.at,
          },
          counterDelta({
            kind: "reply",
            before: null,
            after: state,
            threadVisible: true,
            visibleReplies: 0,
            isFeatured: false,
            // 新楼层一定是主题里最大的，所以主题指针可以前移
            isLatest: true,
          }),
        );
        // outbox（M7）：与业务同事务登记；threadAuthorId 来自锁内的主题行，不借第二条连接
        enqueued.push(
          await enqueueEventInTx(
            tx,
            state === "visible" ? "thread.replied" : "content.submitted",
            state === "visible"
              ? {
                  threadId: thread.id,
                  postId,
                  forumId: thread.forumId,
                  authorId,
                  threadAuthorId: thread.authorId,
                  replyToPostId: replyTo ?? undefined,
                  replyToAuthorId,
                }
              : { postId, threadId: thread.id, authorId, forumId: thread.forumId, isThread: false },
            { actorId: authorId, source: "posting" },
          ),
        );
        for (const u of uploads) {
          enqueued.push(
            await enqueueEventInTx(
              tx,
              "attachment.uploaded",
              { attachmentId: u.attachmentId, fileId: u.fileId, uploaderId: authorId },
              { actorId: authorId, source: "posting" },
            ),
          );
        }
        return { ok: true, threadId: thread.id, postId, floor, state, duplicate: false };
      }, POINTS_TX_OPTIONS),
    );
    // 快路径：派发并标记；失败留在 outbox，捎带巡检顺手补一小批积压
    await dispatchOutboxRows(enqueued, {
      emitter: deps.emitter ? (deps.emitter as unknown as OutboxEmitter) : undefined,
    });
    await sweepPending();
    return out;
  } catch (e) {
    if (e instanceof Rollback) return e.result;
    throw e;
  }
}
