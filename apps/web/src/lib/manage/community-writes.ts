import "server-only";

import { z } from "zod";
import {
  FORUMS_DENIAL_HTTP,
  prepareApiForumAddPrefix,
  prepareApiForumCreate,
  prepareApiForumDelete,
  prepareApiForumRemovePrefix,
  prepareApiForumUpdate,
  type ForumCreateInput,
  type ForumUpdateInput,
} from "@/lib/forums/admin";
import {
  POLLS_DENIAL_HTTP,
  prepareApiPollClose,
  prepareApiPollDelete,
  prepareApiPollReopen,
} from "@/lib/poll/admin";
import { PM_DENIAL_HTTP, prepareApiPmMessageDelete } from "@/lib/pm/admin";
import { commitWrite, type DenialHttpMap } from "@/lib/manage/content-writes";
import type { ManageHandlerContext } from "@/lib/manage/route";

/**
 * 社区结构域适配层（M20.3 Step 4）：版块 / 投票 / 私信的写端点接入。
 * 三域现状只有 site.admin 总门（polls 的版主实时鉴权在服务层保留），端点 permission 留空。
 */

export const COMMUNITY_WRITES_DENIAL_HTTP: DenialHttpMap = {
  ...FORUMS_DENIAL_HTTP,
  ...POLLS_DENIAL_HTTP,
  ...PM_DENIAL_HTTP,
};

/** API 操作者恒为令牌持有人；审计 trace 携带 requestId 与令牌尾号。 */
function apiAudit(ctx: ManageHandlerContext) {
  return {
    admin: { userId: ctx.token.userId, ip: ctx.ip, via: "api" as const },
    actor: { userId: ctx.token.userId, ip: ctx.ip, via: "api" as const },
    trace: { requestId: ctx.requestId, tokenSuffix: ctx.token.suffix },
  };
}

type WriteInput<T> = { targetId: number; idempotencyKey: string; input: T };

// ---------- 版块 ----------

/** 创建版块请求体（kind: section 分组 / forum 版块，与后台表单同枚举）。 */
export const manageForumCreateInput = z.strictObject({
  parentId: z.number().int().min(1),
  kind: z.enum(["section", "forum"]),
  name: z.string().trim().min(1).max(50),
  description: z.string().max(500).nullable(),
  sortOrder: z.number().int().min(0).max(9999).default(0),
  isListed: z.boolean().default(true),
});

export function createManageForum(
  ctx: ManageHandlerContext,
  params: WriteInput<z.infer<typeof manageForumCreateInput>>,
): Promise<unknown> {
  const { actor, trace } = apiAudit(ctx);
  const input: ForumCreateInput = { ...params.input };
  return commitWrite(
    ctx,
    "forums.create",
    { targetId: params.input.parentId, idempotencyKey: params.idempotencyKey, input: params.input },
    prepareApiForumCreate(actor, input, trace),
    COMMUNITY_WRITES_DENIAL_HTTP,
  );
}

/** 编辑版块请求体（全量字段 + 三策略；iconKey 不在此端点）。 */
export const manageForumUpdateInput = z.strictObject({
  parentId: z.number().int().min(1),
  name: z.string().trim().min(1).max(50),
  description: z.string().max(500).nullable(),
  sortOrder: z.number().int().min(0).max(9999).default(0),
  isListed: z.boolean().default(true),
  readPolicy: z.enum(["inherit", "public", "members", "restricted"]),
  writePolicy: z.enum(["inherit", "members", "restricted"]),
  reviewPolicy: z.enum(["inherit", "none", "threads", "all"]),
  isArchived: z.boolean().default(false),
});

export function updateManageForum(
  ctx: ManageHandlerContext,
  params: WriteInput<z.infer<typeof manageForumUpdateInput>>,
): Promise<unknown> {
  const { actor, trace } = apiAudit(ctx);
  const input: ForumUpdateInput = { ...params.input };
  return commitWrite(
    ctx,
    "forums.edit",
    params,
    prepareApiForumUpdate(actor, params.targetId, input, trace),
    COMMUNITY_WRITES_DENIAL_HTTP,
  );
}

export function deleteManageForum(
  ctx: ManageHandlerContext,
  params: WriteInput<Record<string, never>>,
): Promise<unknown> {
  const { actor, trace } = apiAudit(ctx);
  return commitWrite(
    ctx,
    "forums.delete",
    { targetId: params.targetId, idempotencyKey: params.idempotencyKey, input: {} },
    prepareApiForumDelete(actor, params.targetId, trace),
    COMMUNITY_WRITES_DENIAL_HTTP,
  );
}

export const manageForumDeleteInput = z.strictObject({});

export const manageForumPrefixInput = z.strictObject({
  name: z.string().trim().min(1).max(64),
  sortOrder: z.number().int().min(0).max(9999).default(0),
});

export function addManageForumPrefix(
  ctx: ManageHandlerContext,
  params: WriteInput<z.infer<typeof manageForumPrefixInput>>,
): Promise<unknown> {
  const { actor, trace } = apiAudit(ctx);
  return commitWrite(
    ctx,
    "forums.prefix-add",
    params,
    prepareApiForumAddPrefix(actor, params.targetId, params.input, trace),
    COMMUNITY_WRITES_DENIAL_HTTP,
  );
}

/** 移除前缀：prefixId 由路由从路径解析后传入（归属锁在服务层）。 */
export function removeManageForumPrefix(
  ctx: ManageHandlerContext,
  params: { targetId: number; idempotencyKey: string; prefixId: number },
): Promise<unknown> {
  const { actor, trace } = apiAudit(ctx);
  return commitWrite(
    ctx,
    "forums.prefix-remove",
    { targetId: params.targetId, idempotencyKey: params.idempotencyKey, input: {} },
    prepareApiForumRemovePrefix(actor, params.targetId, params.prefixId, trace),
    COMMUNITY_WRITES_DENIAL_HTTP,
  );
}

// ---------- 投票 ----------

export const managePollActionInput = z.strictObject({});

export function closeManagePoll(
  ctx: ManageHandlerContext,
  params: WriteInput<Record<string, never>>,
): Promise<unknown> {
  const { admin, trace } = apiAudit(ctx);
  return commitWrite(
    ctx,
    "polls.close",
    { targetId: params.targetId, idempotencyKey: params.idempotencyKey, input: {} },
    prepareApiPollClose(admin, params.targetId, trace),
    COMMUNITY_WRITES_DENIAL_HTTP,
  );
}

export function reopenManagePoll(
  ctx: ManageHandlerContext,
  params: WriteInput<Record<string, never>>,
): Promise<unknown> {
  const { admin, trace } = apiAudit(ctx);
  return commitWrite(
    ctx,
    "polls.reopen",
    { targetId: params.targetId, idempotencyKey: params.idempotencyKey, input: {} },
    prepareApiPollReopen(admin, params.targetId, trace),
    COMMUNITY_WRITES_DENIAL_HTTP,
  );
}

export function deleteManagePoll(
  ctx: ManageHandlerContext,
  params: WriteInput<Record<string, never>>,
): Promise<unknown> {
  const { admin, trace } = apiAudit(ctx);
  return commitWrite(
    ctx,
    "polls.delete",
    { targetId: params.targetId, idempotencyKey: params.idempotencyKey, input: {} },
    prepareApiPollDelete(admin, params.targetId, trace),
    COMMUNITY_WRITES_DENIAL_HTTP,
  );
}

// ---------- 私信 ----------

export const managePmDeleteInput = z.strictObject({
  reason: z.string().trim().min(1).max(255),
});

export function deleteManagePmMessage(
  ctx: ManageHandlerContext,
  params: WriteInput<z.infer<typeof managePmDeleteInput>>,
): Promise<unknown> {
  const { admin, trace } = apiAudit(ctx);
  return commitWrite(
    ctx,
    "pm.message-delete",
    params,
    prepareApiPmMessageDelete(admin, params.targetId, params.input.reason, trace),
    COMMUNITY_WRITES_DENIAL_HTTP,
  );
}
