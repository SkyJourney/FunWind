import "server-only";

import { z } from "zod";
import {
  BADGES_DENIAL_HTTP,
  prepareApiBadgeGrant,
  prepareApiBadgeRevoke,
} from "@/lib/badges/service";
import { EMOJIS_DENIAL_HTTP } from "@/lib/emoji/service";
import {
  prepareApiEmojiEnabled,
  prepareApiEmojiGroupCreate,
  prepareApiEmojiGroupDelete,
  prepareApiEmojiGroupEnabled,
  prepareApiEmojiGroupRename,
  prepareApiEmojiGroupReorder,
  prepareApiEmojiUpdate,
} from "@/lib/emoji/service";
import { POINTS_DENIAL_HTTP, prepareApiPointsAdjust } from "@/lib/points/adjust";
import { commitWrite, type DenialHttpMap } from "@/lib/manage/content-writes";
import type { ManageHandlerContext } from "@/lib/manage/route";

/**
 * 资产域适配层（M20.3 Step 4）：徽章 / 积分 / 表情的写端点接入。
 * 权限点：badges→admin.badges、points→admin.points、emojis→emoji.manage（码表仅供适配层合并）。
 */

export const ASSET_WRITES_DENIAL_HTTP: DenialHttpMap = {
  ...BADGES_DENIAL_HTTP,
  ...POINTS_DENIAL_HTTP,
  ...EMOJIS_DENIAL_HTTP,
};

/** API 操作者恒为令牌持有人；审计 trace 携带 requestId 与令牌尾号。 */
function apiAudit(ctx: ManageHandlerContext) {
  return {
    admin: { userId: ctx.token.userId, ip: ctx.ip, via: "api" as const },
    trace: { requestId: ctx.requestId, tokenSuffix: ctx.token.suffix },
  };
}

type WriteInput<T> = { targetId: number; idempotencyKey: string; input: T };

// ---------- 徽章 ----------

export const manageBadgeGrantInput = z.strictObject({});

export function grantManageBadge(
  ctx: ManageHandlerContext,
  params: { uid: number; badgeId: number; idempotencyKey: string },
): Promise<unknown> {
  const { admin, trace } = apiAudit(ctx);
  return commitWrite(
    ctx,
    "badges.grant",
    { targetId: params.uid, idempotencyKey: params.idempotencyKey, input: {} },
    prepareApiBadgeGrant(admin, params.uid, params.badgeId, trace),
    ASSET_WRITES_DENIAL_HTTP,
  );
}

export function revokeManageBadge(
  ctx: ManageHandlerContext,
  params: { uid: number; badgeId: number; idempotencyKey: string },
): Promise<unknown> {
  const { admin, trace } = apiAudit(ctx);
  return commitWrite(
    ctx,
    "badges.revoke",
    { targetId: params.uid, idempotencyKey: params.idempotencyKey, input: {} },
    prepareApiBadgeRevoke(admin, params.uid, params.badgeId, trace),
    ASSET_WRITES_DENIAL_HTTP,
  );
}

// ---------- 积分 ----------

export const managePointsAdjustInput = z.strictObject({
  userId: z.number().int().min(1),
  delta: z.number().int(),
  note: z.string().trim().min(1).max(255),
});

export function adjustManagePoints(
  ctx: ManageHandlerContext,
  params: WriteInput<z.infer<typeof managePointsAdjustInput>>,
): Promise<unknown> {
  const { admin, trace } = apiAudit(ctx);
  return commitWrite(
    ctx,
    "points.adjust",
    params,
    prepareApiPointsAdjust(admin, params.input, trace),
    ASSET_WRITES_DENIAL_HTTP,
  );
}

// ---------- 表情 ----------

export const manageEmojiGroupCreateInput = z.strictObject({
  name: z.string().trim().min(1).max(50),
});

export function createManageEmojiGroup(
  ctx: ManageHandlerContext,
  params: WriteInput<z.infer<typeof manageEmojiGroupCreateInput>>,
): Promise<unknown> {
  const { admin, trace } = apiAudit(ctx);
  return commitWrite(
    ctx,
    "emojis.group-create",
    params,
    prepareApiEmojiGroupCreate(admin, params.input.name, trace),
    ASSET_WRITES_DENIAL_HTTP,
  );
}

export const manageEmojiGroupRenameInput = z.strictObject({
  name: z.string().trim().min(1).max(50),
});

export function renameManageEmojiGroup(
  ctx: ManageHandlerContext,
  params: WriteInput<z.infer<typeof manageEmojiGroupRenameInput>>,
): Promise<unknown> {
  const { admin, trace } = apiAudit(ctx);
  return commitWrite(
    ctx,
    "emojis.group-rename",
    params,
    prepareApiEmojiGroupRename(admin, params.targetId, params.input.name, trace),
    ASSET_WRITES_DENIAL_HTTP,
  );
}

export const manageEmojiEnabledInput = z.strictObject({ enabled: z.boolean() });

export function toggleManageEmojiGroup(
  ctx: ManageHandlerContext,
  params: WriteInput<z.infer<typeof manageEmojiEnabledInput>>,
): Promise<unknown> {
  const { admin, trace } = apiAudit(ctx);
  return commitWrite(
    ctx,
    "emojis.group-enabled",
    params,
    prepareApiEmojiGroupEnabled(admin, params.targetId, params.input.enabled, trace),
    ASSET_WRITES_DENIAL_HTTP,
  );
}

export function deleteManageEmojiGroup(
  ctx: ManageHandlerContext,
  params: WriteInput<Record<string, never>>,
): Promise<unknown> {
  const { admin, trace } = apiAudit(ctx);
  return commitWrite(
    ctx,
    "emojis.group-delete",
    { targetId: params.targetId, idempotencyKey: params.idempotencyKey, input: {} },
    prepareApiEmojiGroupDelete(admin, params.targetId, trace),
    ASSET_WRITES_DENIAL_HTTP,
  );
}

export const manageEmojiGroupDeleteInput = z.strictObject({});

export const manageEmojiGroupReorderInput = z.strictObject({
  sort: z.number().int().min(0).max(9999),
});

export function reorderManageEmojiGroup(
  ctx: ManageHandlerContext,
  params: WriteInput<z.infer<typeof manageEmojiGroupReorderInput>>,
): Promise<unknown> {
  const { admin, trace } = apiAudit(ctx);
  return commitWrite(
    ctx,
    "emojis.group-reorder",
    params,
    prepareApiEmojiGroupReorder(admin, params.targetId, params.input.sort, trace),
    ASSET_WRITES_DENIAL_HTTP,
  );
}

export const manageEmojiUpdateInput = z.strictObject({
  name: z.string().trim().min(1).max(50),
  keywords: z.string().trim().max(200).default(""),
  sort: z.number().int().min(0).max(9999),
});

export function updateManageEmoji(
  ctx: ManageHandlerContext,
  params: WriteInput<z.infer<typeof manageEmojiUpdateInput>>,
): Promise<unknown> {
  const { admin, trace } = apiAudit(ctx);
  return commitWrite(
    ctx,
    "emojis.update",
    params,
    prepareApiEmojiUpdate(admin, params.targetId, params.input, trace),
    ASSET_WRITES_DENIAL_HTTP,
  );
}

export function toggleManageEmoji(
  ctx: ManageHandlerContext,
  params: WriteInput<z.infer<typeof manageEmojiEnabledInput>>,
): Promise<unknown> {
  const { admin, trace } = apiAudit(ctx);
  return commitWrite(
    ctx,
    "emojis.enabled",
    params,
    prepareApiEmojiEnabled(admin, params.targetId, params.input.enabled, trace),
    ASSET_WRITES_DENIAL_HTTP,
  );
}
