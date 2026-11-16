"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { announcements, getWebDb, insertIdOf } from "@funwind/db";
import { defineAction } from "@/lib/actions/define-action";
import { writeAudit, type DbTx } from "@/lib/audit";
import { nowBeijingWallTime } from "@/lib/datetime";
import {
  enqueueEventInTx,
  dispatchOutboxRows,
  sweepPending,
  type EnqueuedEvent,
} from "@/lib/events/outbox";
import { POINTS_TX_OPTIONS } from "@/lib/points/retry";

/**
 * 公告 Server Actions（M9，site.admin 总门——拍板 5：唯一管理员操作，不新增权限点）。
 * 公告发布/编辑同事务写 announcement.published 事件（经 outbox）；下线=ends_at 置当前。
 * 站点框架（导航/友链/页脚）已于 M19 Q3 迁入 /admin/settings（同文件 saveNav/Links/FooterAction）。
 */

const createAnnouncementInput = z.object({
  title: z.string().trim().min(1, "标题不能为空").max(200),
  bodyMd: z.string().max(20_000).default(""),
  level: z.enum(["info", "important"]).default("info"),
  audience: z.enum(["all", "members"]).default("all"),
  showBanner: z.enum(["on"]).optional(),
  startsAt: z.string().max(32).default(""),
  endsAt: z.string().max(32).default(""),
});

function toDatetime(local: string): string {
  // datetime-local（YYYY-MM-DDTHH:MM）→ 北京墙面 DATETIME（YYYY-MM-DD HH:MM:SS）
  if (!local) return nowBeijingWallTime();
  return `${local.replace("T", " ")}:00`.slice(0, 19);
}

/** 编辑/下线共用同一行锁与状态快照，保证变更前值与审计记录来自同一事务。 */
async function lockAnnouncement(tx: DbTx, id: number) {
  const [row] = await tx
    .select({
      title: announcements.title,
      bodyMd: announcements.bodyMd,
      level: announcements.level,
      audience: announcements.audience,
      showBanner: announcements.showBanner,
      startsAt: announcements.startsAt,
      endsAt: announcements.endsAt,
    })
    .from(announcements)
    .where(eq(announcements.id, id))
    .limit(1)
    .for("update");
  return row ?? null;
}

export const createAnnouncementAction = defineAction({
  name: "admin.announcement.create",
  auth: { admin: "site.admin" },
  input: createAnnouncementInput,
  async run(ctx, input) {
    const enqueued: EnqueuedEvent[] = [];
    let announcementId = 0;
    const values = {
      title: input.title,
      bodyMd: input.bodyMd,
      level: input.level,
      audience: input.audience,
      showBanner: input.showBanner === "on",
      startsAt: toDatetime(input.startsAt),
      endsAt: input.endsAt ? toDatetime(input.endsAt) : null,
      createdBy: ctx.userId ?? 0,
    };
    await getWebDb().transaction(async (tx) => {
      announcementId = insertIdOf(
        await tx.insert(announcements).values({
          ...values,
          createdAt: nowBeijingWallTime(),
          updatedAt: nowBeijingWallTime(),
        }),
      );
      await writeAudit(tx, {
        actorId: ctx.userId ?? null,
        action: "announcement.create",
        targetType: "announcement",
        targetId: announcementId,
        before: null,
        after: values,
        ip: ctx.ip,
      });
      enqueued.push(
        await enqueueEventInTx(
          tx,
          "announcement.published",
          { announcementId, createdBy: ctx.userId ?? 0 },
          { actorId: ctx.userId ?? undefined, source: "admin" },
        ),
      );
    }, POINTS_TX_OPTIONS);
    await dispatchOutboxRows(enqueued);
    await sweepPending();
    revalidatePath("/admin/announcements");
    revalidatePath("/");
    redirect(`/admin/announcements?created=1`);
  },
});

/** 编辑公告（M9.5 站长拍板补能力）：字段同创建；startsAt 留空 = 保留原值；不重发 published 事件 */
export const editAnnouncementAction = defineAction({
  name: "admin.announcement.edit",
  auth: { admin: "site.admin" },
  input: createAnnouncementInput.extend({ id: z.coerce.number().int().positive() }),
  async run(ctx, input) {
    let found = false;
    await getWebDb().transaction(async (tx) => {
      const orig = await lockAnnouncement(tx, input.id);
      if (!orig) return;
      found = true;
      const values = {
        title: input.title,
        bodyMd: input.bodyMd,
        level: input.level,
        audience: input.audience,
        showBanner: input.showBanner === "on",
        startsAt: input.startsAt ? toDatetime(input.startsAt) : orig.startsAt,
        endsAt: input.endsAt ? toDatetime(input.endsAt) : null,
      };
      await tx
        .update(announcements)
        .set({ ...values, updatedAt: nowBeijingWallTime() })
        .where(eq(announcements.id, input.id));
      if (JSON.stringify(orig) !== JSON.stringify(values)) {
        await writeAudit(tx, {
          actorId: ctx.userId ?? null,
          action: "announcement.edit",
          targetType: "announcement",
          targetId: input.id,
          before: orig,
          after: values,
          ip: ctx.ip,
        });
      }
    });
    if (!found) redirect(`/admin/announcements?err=${encodeURIComponent("公告不存在")}`);
    revalidatePath("/admin/announcements");
    revalidatePath("/");
    redirect(`/admin/announcements?updated=1`);
  },
});

const endAnnouncementInput = z.object({ id: z.coerce.number().int().positive() });
export const endAnnouncementAction = defineAction({
  name: "admin.announcement.end",
  auth: { admin: "site.admin" },
  input: endAnnouncementInput,
  async run(ctx, input) {
    let found = false;
    await getWebDb().transaction(async (tx) => {
      const orig = await lockAnnouncement(tx, input.id);
      if (!orig) return;
      found = true;
      const endedAt = nowBeijingWallTime();
      await tx
        .update(announcements)
        .set({ endsAt: endedAt, updatedAt: endedAt })
        .where(eq(announcements.id, input.id));
      await writeAudit(tx, {
        actorId: ctx.userId ?? null,
        action: "announcement.end",
        targetType: "announcement",
        targetId: input.id,
        before: { endsAt: orig.endsAt },
        after: { endsAt: endedAt },
        ip: ctx.ip,
      });
    });
    if (!found) redirect(`/admin/announcements?err=${encodeURIComponent("公告不存在")}`);
    revalidatePath("/admin/announcements");
    revalidatePath("/");
    redirect(`/admin/announcements?ended=1`);
  },
});
