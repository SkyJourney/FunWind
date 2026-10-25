import { defineModule } from "../kernel/types";
import { NOTIFICATION_TYPE_SPECS } from "@/lib/notifications/render";
import { notify } from "@/lib/notifications/notify";
import { getWebDb, posts, threads } from "@funwind/db";
import { eq } from "drizzle-orm";

/**
 * 通知模块（M8）：类型目录全量注册（审核/私信/系统类本期只注册可渲染，生产方在 M9/M10）；
 * 消费互动事件（经 outbox 可靠派发）→ notify()。业务实现在 lib/notifications/。
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
    "通知中心：类型目录全量注册 + 互动事件消费（回复/提及/点赞/关注/门控收益/积分调整/徽章）→ notify() 管线。",
  notificationTypes: NOTIFICATION_TYPE_SPECS.map((s) => ({
    key: s.key,
    category: s.category,
    aggregate: s.aggregate,
    mandatory: s.mandatory,
  })),
  events: {
    "thread.replied": async (p) => {
      const title = await threadTitle(p.threadId);
      const recipients: { userId: number; type: string; groupKey: string }[] = [];
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
        recipients.push({
          userId: p.replyToAuthorId,
          type: "post.reply_to",
          groupKey: `post:${p.replyToPostId}:replied`,
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
          data: { title: title ?? "", threadId: p.threadId },
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
  },
});
