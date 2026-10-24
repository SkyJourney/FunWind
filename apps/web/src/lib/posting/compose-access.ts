import { checkPermission } from "@/lib/authz/service";
import { getAuthzSnapshot } from "@/lib/authz/snapshot";
import type { Subject } from "@/lib/authz/types";
import { composeAccess, replyAccess, type ComposeAccess } from "./compose";

/** 版块是否已归档：自身或任一祖先归档即为归档（与评估器的判定一致） */
async function isArchivedForum(forumId: number): Promise<boolean> {
  const snap = await getAuthzSnapshot();
  return snap.tree.chain(forumId).some((id) => snap.tree.get(id)?.isArchived === true);
}

/**
 * 观众在某版块发帖的可用性：取权限结论与版块树事实，交给 composeAccess 决定展示。
 * 发帖页（/f/[fid]/new）与版块页的入口共用它。调用方须已确认版块对观众可读。
 */
export async function loadComposeAccess(
  viewer: Subject,
  forumId: number,
  kind: "section" | "forum",
): Promise<ComposeAccess> {
  const snap = await getAuthzSnapshot();
  const canWrite = (await checkPermission(viewer, "forum.write", { forumId })).allowed;
  return composeAccess({
    isGuest: viewer.userId === null,
    canWrite,
    isSection: kind === "section",
    archived: await isArchivedForum(forumId),
    reviewPolicy: snap.tree.reviewPolicy(forumId).value,
  });
}

/**
 * 观众在某主题下快速回复的可用性。主题锁定时把 threadLocked 传给评估器：
 * 普通成员被拒，持 thread.replyLocked 的人仍可回复。调用方须已确认主题对观众可见。
 */
export async function loadReplyAccess(
  viewer: Subject,
  forumId: number,
  threadLocked: boolean,
): Promise<ComposeAccess> {
  const snap = await getAuthzSnapshot();
  const canWrite = (await checkPermission(viewer, "forum.write", { forumId, threadLocked }))
    .allowed;
  return replyAccess({
    isGuest: viewer.userId === null,
    canWrite,
    archived: await isArchivedForum(forumId),
    threadLocked,
    reviewPolicy: snap.tree.reviewPolicy(forumId).value,
  });
}
