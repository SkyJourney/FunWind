"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { announcements, getWebDb } from "@funwind/db";
import { defineAction } from "@/lib/actions/define-action";
import { setSetting } from "@/lib/auth/settings";
import { nowBeijingWallTime } from "@/lib/datetime";
import {
  enqueueEventInTx,
  dispatchOutboxRows,
  sweepPending,
  type EnqueuedEvent,
} from "@/lib/events/outbox";
import { invalidateSiteChrome } from "@/lib/site-chrome";
import { POINTS_TX_OPTIONS } from "@/lib/points/retry";

/**
 * 公告与站点框架 Server Actions（M9，site.admin 总门——拍板 5：唯一管理员操作，不新增权限点）。
 * 公告发布/编辑同事务写 announcement.published 事件（经 outbox）；下线=ends_at 置当前。
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

export const createAnnouncementAction = defineAction({
  name: "admin.announcement.create",
  auth: { admin: "site.admin" },
  input: createAnnouncementInput,
  async run(ctx, input) {
    const enqueued: EnqueuedEvent[] = [];
    let announcementId = 0;
    await getWebDb().transaction(async (tx) => {
      const [row] = (await tx.insert(announcements).values({
        title: input.title,
        bodyMd: input.bodyMd,
        level: input.level,
        audience: input.audience,
        showBanner: input.showBanner === "on",
        startsAt: toDatetime(input.startsAt),
        endsAt: input.endsAt ? toDatetime(input.endsAt) : null,
        createdBy: ctx.userId ?? 0,
        createdAt: nowBeijingWallTime(),
        updatedAt: nowBeijingWallTime(),
      })) as unknown as [{ insertId: number }];
      announcementId = Number(row.insertId);
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

const endAnnouncementInput = z.object({ id: z.coerce.number().int().positive() });
export const endAnnouncementAction = defineAction({
  name: "admin.announcement.end",
  auth: { admin: "site.admin" },
  input: endAnnouncementInput,
  async run(ctx, input) {
    await getWebDb()
      .update(announcements)
      .set({ endsAt: nowBeijingWallTime(), updatedAt: nowBeijingWallTime() })
      .where(eq(announcements.id, input.id));
    void ctx;
    revalidatePath("/admin/announcements");
    revalidatePath("/");
    redirect(`/admin/announcements?ended=1`);
  },
});

/** 站点框架保存（nav/links/footer 三键各自独立保存；setSetting 自带审计） */
const navInput = z.object({
  navRaw: z.string().max(4000).default(""),
});
export const saveNavAction = defineAction({
  name: "admin.site.nav",
  auth: { admin: "site.admin" },
  input: navInput,
  async run(ctx, input) {
    const items = parseLines(input.navRaw).map(([label, href]) => ({ label, href }));
    await setSetting("site.nav", items, { userId: ctx.userId ?? null, via: "admin", ip: ctx.ip });
    invalidateSiteChrome();
    revalidatePath("/", "layout");
    redirect(`/admin/announcements?nav=1`);
  },
});

const linksInput = z.object({
  linksRaw: z.string().max(6000).default(""),
});
export const saveLinksAction = defineAction({
  name: "admin.site.links",
  auth: { admin: "site.admin" },
  input: linksInput,
  async run(ctx, input) {
    const items = parseLines(input.linksRaw).map(([label, href]) => ({ label, href }));
    await setSetting("site.links", items, { userId: ctx.userId ?? null, via: "admin", ip: ctx.ip });
    invalidateSiteChrome();
    revalidatePath("/", "layout");
    redirect(`/admin/announcements?links=1`);
  },
});

const footerInput = z.object({ footerText: z.string().max(300).default("") });
export const saveFooterAction = defineAction({
  name: "admin.site.footer",
  auth: { admin: "site.admin" },
  input: footerInput,
  async run(ctx, input) {
    await setSetting(
      "site.footer",
      { text: input.footerText },
      { userId: ctx.userId ?? null, via: "admin", ip: ctx.ip },
    );
    invalidateSiteChrome();
    revalidatePath("/", "layout");
    redirect(`/admin/announcements?footer=1`);
  },
});

/** 「标签, 路径/URL」逐行解析；非法行丢弃 */
function parseLines(raw: string): [string, string][] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const i = line.indexOf(",");
      return i > 0 ? [line.slice(0, i).trim(), line.slice(i + 1).trim()] : null;
    })
    .filter((x): x is [string, string] => x !== null && x[1].length > 0)
    .slice(0, 20);
}
