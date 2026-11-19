"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { nowBeijingWallTime } from "@/lib/datetime";
import {
  createAnnouncement,
  editAnnouncement,
  endAnnouncement,
  type AnnouncementFields,
} from "@/lib/announcements/service";

/**
 * 公告 Server Actions（M9，site.admin 总门——拍板 5：唯一管理员操作，不新增权限点）。
 * 写入语义在 lib/announcements/service.ts（M20.3 Step 3 抽出，与 REST 双入口共享内核）；
 * 本文件只负责表单收参（datetime-local 归一化）、redirect 与缓存失效。
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

function toFields(input: z.infer<typeof createAnnouncementInput>): AnnouncementFields {
  return {
    title: input.title,
    bodyMd: input.bodyMd,
    level: input.level,
    audience: input.audience,
    showBanner: input.showBanner === "on",
    // startsAt/endsAt 留空 = null，语义由服务层按入口区分：创建取当前时刻、编辑保留原值
    startsAt: input.startsAt ? toDatetime(input.startsAt) : null,
    endsAt: input.endsAt ? toDatetime(input.endsAt) : null,
  };
}

export const createAnnouncementAction = defineAction({
  name: "admin.announcement.create",
  auth: { admin: "site.admin" },
  input: createAnnouncementInput,
  async run(ctx, input) {
    await createAnnouncement({ userId: ctx.userId, ip: ctx.ip, via: "admin" }, toFields(input));
    revalidatePath("/admin/announcements");
    revalidatePath("/");
    redirect(`/admin/announcements?ok=created`);
  },
});

/** 编辑公告（M9.5 站长拍板补能力）：字段同创建；startsAt 留空 = 保留原值；不重发 published 事件 */
export const editAnnouncementAction = defineAction({
  name: "admin.announcement.edit",
  auth: { admin: "site.admin" },
  input: createAnnouncementInput.extend({ id: z.coerce.number().int().positive() }),
  async run(ctx, input) {
    const result = await editAnnouncement(
      { userId: ctx.userId, ip: ctx.ip, via: "admin" },
      input.id,
      toFields(input),
    );
    if (!result.ok) redirect(`/admin/announcements?err=${encodeURIComponent("公告不存在")}`);
    revalidatePath("/admin/announcements");
    revalidatePath("/");
    redirect(`/admin/announcements?ok=updated`);
  },
});

const endAnnouncementInput = z.object({ id: z.coerce.number().int().positive() });
export const endAnnouncementAction = defineAction({
  name: "admin.announcement.end",
  auth: { admin: "site.admin" },
  input: endAnnouncementInput,
  async run(ctx, input) {
    const result = await endAnnouncement(
      { userId: ctx.userId, ip: ctx.ip, via: "admin" },
      input.id,
    );
    if (!result.ok) redirect(`/admin/announcements?err=${encodeURIComponent("公告不存在")}`);
    revalidatePath("/admin/announcements");
    revalidatePath("/");
    redirect(`/admin/announcements?ok=ended`);
  },
});
