import { notFound } from "next/navigation";
import Link from "next/link";

import { RichContent } from "@/components/content/rich-content";
import { getCurrentSubject } from "@/lib/authz/subject";
import {
  getAnnouncement,
  isAnnouncementRead,
  markAnnouncementRead,
} from "@/lib/announcements/queries";

export const dynamic = "force-dynamic";
export const metadata = { title: "公告" };

/**
 * 公告详情页（M13 追加功能）：/a/{id}
 * 可见性口径与通知中心同源（有效期 + 受众）；游客可见 all 类公告。
 * 登录用户访问即标记该条已读（「看了详情即已读」，与通知中心的「标记已读」语义互补）。
 */
export default async function AnnouncementDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: rawId } = await params;
  const id = /^\d{1,10}$/.test(rawId) ? Number(rawId) : 0;
  if (id <= 0) notFound();

  const subject = await getCurrentSubject();
  const loggedIn = subject.userId !== null;
  // GUEST_SUBJECT 也是对象（userId=null）——登录判定必须看 userId
  const announcement = await getAnnouncement(id, loggedIn);
  if (!announcement) notFound();

  const read = await isAnnouncementRead(id, subject.userId);
  await markAnnouncementRead(id, subject.userId);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10">
      <div className="mb-6 flex items-center gap-3 text-sm text-muted-foreground">
        <Link href="/a" className="hover:text-foreground hover:underline">
          ← 全部公告
        </Link>
        <span aria-hidden="true">·</span>
        <span>
          {announcement.startsAt}
          {announcement.endsAt ? ` ~ ${announcement.endsAt}` : " 起长期有效"}
        </span>
        {read && (
          <>
            <span aria-hidden="true">·</span>
            <span>已读</span>
          </>
        )}
      </div>

      <article className="rounded-xl border bg-card p-6">
        <h1 className="text-2xl font-semibold">{announcement.title}</h1>
        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          <span
            className={
              announcement.level === "important"
                ? "rounded bg-destructive/10 px-2 py-0.5 text-destructive"
                : "rounded bg-muted px-2 py-0.5 text-muted-foreground"
            }
          >
            {announcement.level === "important" ? "重要" : "普通"}
          </span>
          <span className="rounded bg-muted px-2 py-0.5 text-muted-foreground">
            {announcement.audience === "all" ? "所有人可见" : "仅登录会员"}
          </span>
          {announcement.showBanner && (
            <span className="rounded bg-muted px-2 py-0.5 text-muted-foreground">顶部横幅</span>
          )}
        </div>
        <div className="content-md mt-6">
          <RichContent md={announcement.bodyMd} />
        </div>
      </article>
    </main>
  );
}
