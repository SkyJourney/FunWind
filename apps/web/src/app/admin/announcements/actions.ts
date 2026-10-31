"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { announcements, getWebDb, insertIdOf } from "@funwind/db";
import { defineAction } from "@/lib/actions/define-action";
import { writeAudit, type DbTx } from "@/lib/audit";
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

/** 站点框架保存（nav/links/footer 三键各自独立保存；setSetting 自带审计） */
const navInput = z.object({
  navRaw: z.string().max(4000).default(""),
});
export const saveNavAction = defineAction({
  name: "admin.site.nav",
  auth: { admin: "site.admin" },
  input: navInput,
  async run(ctx, input) {
    const parsed = parseLinesChecked(input.navRaw, { hrefMustBePath: true });
    if (parsed.error) redirect(`/admin/announcements?navErr=${encodeURIComponent(parsed.error)}`);
    await setSetting("site.nav", parsed.items, {
      userId: ctx.userId ?? null,
      via: "admin",
      ip: ctx.ip,
    });
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
    const parsed = parseLinesChecked(input.linksRaw, { hrefMustBePath: false });
    if (parsed.error) redirect(`/admin/announcements?linksErr=${encodeURIComponent(parsed.error)}`);
    await setSetting("site.links", parsed.items, {
      userId: ctx.userId ?? null,
      via: "admin",
      ip: ctx.ip,
    });
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

/** 「标签, 路径/URL」逐行解析；非法行报行号（M9.5 条目化编辑配套） */
function parseLinesChecked(
  raw: string,
  opts: { hrefMustBePath: boolean },
): { items: { label: string; href: string }[]; error: string | null } {
  const items: { label: string; href: string }[] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    const idx = line.indexOf(",");
    if (idx <= 0 || idx === line.length - 1) {
      return { items: [], error: `第 ${i + 1} 行格式不对：应为「名称,路径」（半角逗号分隔）` };
    }
    const label = line.slice(0, idx).trim();
    const href = line.slice(idx + 1).trim();
    if (opts.hrefMustBePath && !href.startsWith("/")) {
      return { items: [], error: `第 ${i + 1} 行路径必须以 / 开头（导航项只能是站内路径）` };
    }
    if (!opts.hrefMustBePath && !(href.startsWith("/") || href.startsWith("http"))) {
      return { items: [], error: `第 ${i + 1} 行链接必须是站内路径（/ 开头）或 http(s):// 链接` };
    }
    items.push({ label, href });
    if (items.length >= 20) break;
  }
  return { items, error: null };
}
