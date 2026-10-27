import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { desc } from "drizzle-orm";
import { announcements, getWebDb } from "@funwind/db";
import { requireAdmin } from "@/lib/authz/require-admin";
import { getSiteChrome } from "@/lib/site-chrome";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  createAnnouncementAction,
  endAnnouncementAction,
  saveFooterAction,
  saveLinksAction,
  saveNavAction,
} from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "公告与站点框架" };

type Params = {
  searchParams: Promise<Record<string, string | undefined>>;
};

/** 公告管理 + 站点框架（M9，site.admin 总门）：公告 CRUD、导航/友链/页脚配置（site_settings JSON）。 */
export default async function AdminAnnouncementsPage({ searchParams }: Params) {
  await requireAdmin();
  const sp = await searchParams;
  const [rows, chrome] = await Promise.all([
    getWebDb().select().from(announcements).orderBy(desc(announcements.id)).limit(20),
    getSiteChrome(),
  ]);
  const flash = Object.entries({
    created: "公告已发布（铃铛对全部受众出现未读）。",
    ended: "公告已下线。",
    nav: "导航已保存并即时生效。",
    links: "友链已保存并即时生效。",
    footer: "页脚已保存并即时生效。",
  }).find(([k]) => sp[k] === "1")?.[1];

  return (
    <div className="space-y-4">
      {flash && (
        <p className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
          {flash}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>发布公告</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={createAnnouncementAction} className="space-y-3">
            <input
              name="title"
              required
              maxLength={200}
              placeholder="标题"
              className="w-full rounded-lg border bg-background px-3 py-1.5 text-sm"
            />
            <textarea
              name="bodyMd"
              rows={4}
              maxLength={20_000}
              placeholder="正文（Markdown）"
              className="w-full rounded-lg border bg-background px-3 py-1.5 text-sm"
            />
            <div className="flex flex-wrap gap-3 text-sm">
              <select
                name="level"
                aria-label="级别"
                className="rounded-lg border bg-background px-2.5 py-1.5"
              >
                <option value="info">普通</option>
                <option value="important">重要</option>
              </select>
              <select
                name="audience"
                aria-label="受众"
                className="rounded-lg border bg-background px-2.5 py-1.5"
              >
                <option value="all">所有人（含游客）</option>
                <option value="members">仅登录会员</option>
              </select>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" name="showBanner" value="on" /> 顶部横幅
              </label>
              <input
                type="datetime-local"
                name="startsAt"
                aria-label="开始时间（默认现在）"
                className="rounded-lg border bg-background px-2.5 py-1.5"
              />
              <input
                type="datetime-local"
                name="endsAt"
                aria-label="结束时间（空为长期）"
                className="rounded-lg border bg-background px-2.5 py-1.5"
              />
            </div>
            <SubmitButton
              className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
              pendingText="发布中…"
            >
              发布
            </SubmitButton>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>公告列表（最近 20 条）</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y">
            {rows.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    {a.level === "important" && (
                      <span className="mr-1 text-destructive">[重要]</span>
                    )}
                    {a.title}
                    {a.showBanner && (
                      <span className="ml-1 text-xs text-muted-foreground">（横幅）</span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {a.audience === "all" ? "所有人" : "会员"} · {a.startsAt} ~ {a.endsAt ?? "长期"}
                  </p>
                </div>
                {a.endsAt === null && (
                  <form action={endAnnouncementAction}>
                    <input type="hidden" name="id" value={a.id} />
                    <ConfirmSubmit
                      title="下线公告"
                      description="确认下线此公告？"
                      className="text-xs text-destructive hover:underline disabled:opacity-60"
                      pendingText="…"
                    >
                      下线
                    </ConfirmSubmit>
                  </form>
                )}
              </li>
            ))}
            {rows.length === 0 && (
              <li className="py-4 text-center text-sm text-muted-foreground">暂无公告</li>
            )}
          </ul>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>导航项</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={saveNavAction} className="space-y-2">
              <textarea
                name="navRaw"
                rows={5}
                className="w-full rounded-lg border bg-background px-2.5 py-1.5 font-mono text-xs"
                defaultValue={chrome.nav.map((n) => `${n.label},${n.href}`).join("\n")}
                placeholder={"标签,/路径\n例如：动画,/f/951"}
              />
              <SubmitButton
                className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                pendingText="…"
              >
                保存导航
              </SubmitButton>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>友情链接</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={saveLinksAction} className="space-y-2">
              <textarea
                name="linksRaw"
                rows={5}
                className="w-full rounded-lg border bg-background px-2.5 py-1.5 font-mono text-xs"
                defaultValue={chrome.links.map((l) => `${l.label},${l.href}`).join("\n")}
                placeholder={"名称,https://…"}
              />
              <SubmitButton
                className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                pendingText="…"
              >
                保存友链
              </SubmitButton>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>页脚</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={saveFooterAction} className="space-y-2">
              <textarea
                name="footerText"
                rows={5}
                maxLength={300}
                className="w-full rounded-lg border bg-background px-2.5 py-1.5 text-sm"
                defaultValue={chrome.footerText}
                placeholder="版权/备案/联系方式等纯文本"
              />
              <SubmitButton
                className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                pendingText="…"
              >
                保存页脚
              </SubmitButton>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
