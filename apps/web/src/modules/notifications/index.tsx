import { defineModule } from "../kernel/types";
import { NOTIFICATION_TYPE_SPECS } from "@/lib/notifications/render";
import { notify } from "@/lib/notifications/notify";
import { securityEmailEnabled, sendUserEmail, userEmailEnabled } from "@/lib/notifications/email";
import { gateSoldMail, restrictionMail, contentApprovedMail } from "@/lib/auth/mailer";
import { getForumModerators } from "@/lib/authz/service";
import { forums, getWebDb, posts, roles, threads, users } from "@funwind/db";
import { eq } from "drizzle-orm";

/**
 * 通知模块（M8 建，M9 扩）：类型目录全量注册；消费互动与审核事件（经 outbox 可靠派发）→ notify()。
 * M9 新增生产方：content.submitted（作者回执+版主聚合）、content.moderated（审核结果给作者）、
 * restriction.changed / role.changed（强制通知）。私信类（M10）仍只注册可渲染。业务实现在 lib/notifications/。
 */

/** 线程标题快照（通知 data 用） */
async function threadTitle(threadId: number): Promise<string | null> {
  const [row] = await getWebDb()
    .select({ title: threads.title })
    .from(threads)
    .where(eq(threads.id, threadId))
    .limit(1);
  return row?.title ?? null;
}

export const notificationsModule = defineModule({
  id: "notifications",
  description:
    "通知中心：类型目录全量注册 + 互动事件消费（回复/提及/点赞/关注/锁定内容收益/积分调整/徽章）→ notify() 管线。",
  notificationTypes: NOTIFICATION_TYPE_SPECS.map((s) => ({
    key: s.key,
    category: s.category,
    aggregate: s.aggregate,
    mandatory: s.mandatory,
  })),
  events: {
    "thread.replied": async (p) => {
      const title = await threadTitle(p.threadId);
      const recipients: { userId: number; type: string; groupKey: string; floor?: number }[] = [];
      if (p.threadAuthorId !== p.authorId) {
        recipients.push({
          userId: p.threadAuthorId,
          type: "post.replied",
          groupKey: `thread:${p.threadId}:replied`,
        });
      }
      if (
        p.replyToAuthorId !== undefined &&
        p.replyToAuthorId !== p.authorId &&
        p.replyToAuthorId !== p.threadAuthorId
      ) {
        // 楼层号来自被回复帖（模板占位符 {floor}）
        const [floorRow] = p.replyToPostId
          ? await getWebDb()
              .select({ floor: posts.floor })
              .from(posts)
              .where(eq(posts.id, p.replyToPostId))
              .limit(1)
          : [];
        recipients.push({
          userId: p.replyToAuthorId,
          type: "post.reply_to",
          groupKey: `post:${p.replyToPostId}:replied`,
          floor: floorRow?.floor,
        });
      }
      for (const r of recipients) {
        await notify({
          type: r.type,
          recipients: [r.userId],
          actorId: p.authorId,
          targetType: "thread",
          targetId: p.threadId,
          groupKey: r.groupKey,
          data:
            r.type === "post.reply_to" && r.floor !== undefined
              ? { floor: r.floor }
              : { title: title ?? "", threadId: p.threadId },
        });
      }
    },
    "post.mentioned": async (p) => {
      await notify({
        type: "post.mentioned",
        recipients: [p.mentionedUserId],
        actorId: p.authorId,
        targetType: "post",
        targetId: p.postId,
        data: {},
      });
    },
    "reaction.added": async (p) => {
      const [post] = await getWebDb()
        .select({ authorId: posts.authorId })
        .from(posts)
        .where(eq(posts.id, p.postId))
        .limit(1);
      if (!post || post.authorId === p.userId) return; // 自己赞自己不通知
      await notify({
        type: "post.liked",
        recipients: [post.authorId],
        actorId: p.userId,
        targetType: "post",
        targetId: p.postId,
        groupKey: `post:${p.postId}:liked`,
        data: {},
      });
    },
    "user.followed": async (p) => {
      if (p.targetType !== "user") return; // 版块关注无通知
      if (p.targetId === p.userId) return;
      await notify({
        type: "user.followed",
        recipients: [p.targetId],
        actorId: p.userId,
        targetType: "user",
        targetId: p.userId,
        groupKey: `user:${p.targetId}:followed`,
        data: {},
      });
    },
    "gate.unlocked": async (p) => {
      if (p.authorId === p.userId) return;
      await notify({
        type: "gate.sold",
        recipients: [p.authorId],
        actorId: p.userId,
        targetType: "gate",
        targetId: p.gateId,
        groupKey: `gate:${p.gateId}:sold`,
        data: { price: p.price },
      });
      // S5 场景邮件：内容售出（用户偏好）
      if (await userEmailEnabled(p.authorId, "gate.sold")) {
        await sendUserEmail(p.authorId, ({ siteName, siteUrl }) =>
          gateSoldMail({ points: p.price, siteUrl }, siteName),
        );
      }
    },
    "points.changed": async (p) => {
      if (p.channel !== "adjust.admin") return; // 只有管理员调整发通知（earn/spend 不打扰）
      await notify({
        type: "points.adjusted",
        recipients: [p.userId],
        targetType: "user",
        targetId: p.userId,
        data: { delta: p.delta > 0 ? `+${p.delta}` : String(p.delta) },
      });
    },
    "badge.awarded": async (p) => {
      await notify({
        type: "badge.awarded",
        recipients: [p.userId],
        targetType: "user",
        targetId: p.userId,
        data: { badgeId: p.badgeId },
      });
    },
    "badge.revoked": async (p) => {
      await notify({
        type: "badge.revoked",
        recipients: [p.userId],
        targetType: "user",
        targetId: p.userId,
        data: { badgeId: p.badgeId },
      });
    },

    // ---- M9：审核与账号类生产方 ----

    "content.submitted": async (p) => {
      // 作者回执：已提交待审（dedup：同一提交动作只一条）
      await notify({
        type: "content.submitted",
        recipients: [p.authorId],
        actorId: p.authorId,
        targetType: "post",
        targetId: p.postId,
        dedupKey: (uid) => `submitted:${p.postId}:${uid}`,
        data: { isThread: p.isThread },
      });
      // 版主聚合：review.pending（forum:{id}:review_pending，「N 条待审核」）
      const moderators = await getForumModerators(p.forumId);
      const recipients = moderators.map((m) => m.userId).filter((id) => id !== p.authorId);
      if (recipients.length > 0) {
        await notify({
          type: "review.pending",
          recipients,
          actorId: p.authorId,
          targetType: "forum",
          targetId: p.forumId,
          groupKey: `forum:${p.forumId}:review_pending`,
          data: { forumId: p.forumId },
        });
      }
    },

    "content.moderated": async (p) => {
      const typeByAction: Record<string, string> = {
        approve: "content.approved",
        reject: "content.rejected",
        remove: "content.removed",
        hide: "content.hidden",
        restore: "content.restored",
        disable: "content.disabled",
      };
      const type = typeByAction[p.action];
      if (!type) return;
      const [post] = await getWebDb()
        .select({ authorId: posts.authorId, threadId: posts.threadId })
        .from(posts)
        .where(eq(posts.id, p.postId))
        .limit(1);
      if (!post || post.authorId === p.operatorId) return;
      await notify({
        type,
        recipients: [post.authorId],
        actorId: p.operatorId,
        targetType: "post",
        targetId: p.postId,
        dedupKey: (uid) => `mod:${p.postId}:${p.action}:${uid}`,
        data: p.reason ? { reason: p.reason } : {},
      });
      // S6 场景邮件：审核通过（用户偏好，docs/EMAIL-SCENARIOS.md）
      if (type === "content.approved" && (await userEmailEnabled(post.authorId, type))) {
        await sendUserEmail(post.authorId, ({ siteName, siteUrl }) =>
          contentApprovedMail({ threadId: post.threadId, siteUrl }, siteName),
        );
      }
    },

    "restriction.changed": async (p) => {
      if (p.userId === p.operatorId) return;
      await notify({
        type: p.action === "created" ? "account.restricted" : "account.restriction_lifted",
        recipients: [p.userId],
        actorId: p.operatorId,
        targetType: "user",
        targetId: p.userId,
        dedupKey: () => `restriction:${p.userId}:${p.kind}:${p.action}:${p.endsAt ?? "perm"}`,
        data: { reason: p.reason ?? "", kind: p.kind, endsAt: p.endsAt ?? null },
      });
      // S3 安全强制类邮件（后台统一开关，docs/EMAIL-SCENARIOS.md）：处罚送达义务
      if (await securityEmailEnabled()) {
        await sendUserEmail(p.userId, ({ siteName }) =>
          restrictionMail(
            {
              lifted: p.action !== "created",
              kind: p.kind,
              reason: p.reason ?? "",
              endsAt: p.endsAt ?? null,
            },
            siteName,
          ),
        );
      }
    },

    "role.changed": async (p) => {
      if (p.userId === p.operatorId) return;
      const [[user], [role], forumRows] = await Promise.all([
        getWebDb()
          .select({ username: users.username })
          .from(users)
          .where(eq(users.id, p.userId))
          .limit(1),
        getWebDb()
          .select({ name: roles.name })
          .from(roles)
          .where(eq(roles.key, p.roleKey))
          .limit(1),
        p.scopeId === 0
          ? Promise.resolve([])
          : getWebDb()
              .select({ name: forums.name })
              .from(forums)
              .where(eq(forums.id, p.scopeId))
              .limit(1),
      ]);
      const validity =
        p.action === "revoked" ? "已移除" : p.expiresAt ? `有效至 ${p.expiresAt}` : "长期有效";
      await notify({
        type: "account.role_changed",
        recipients: [p.userId],
        actorId: p.operatorId,
        targetType: "user",
        targetId: p.userId,
        dedupKey: () =>
          `role:${p.userId}:${p.roleKey}:${p.scopeId}:${p.action}:${p.expiresAt ?? "none"}`,
        data: {
          roleKey: p.roleKey,
          roleName: role?.name ?? p.roleKey,
          action: p.action,
          actionText: p.action === "granted" ? "已授予" : "已撤销",
          scopeLabel: p.scopeId === 0 ? "全站" : `板块 ${forumRows[0]?.name ?? p.scopeId} 及子树`,
          validity,
          username: user?.username ?? "",
        },
      });
    },
  },
});
