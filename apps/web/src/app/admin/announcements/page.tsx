import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import Link from "next/link";
import { count, desc, isNull, or, sql } from "drizzle-orm";
import { announcements, getWebDb } from "@funwind/db";
import { requireAdmin } from "@/lib/authz/require-admin";
import { getSiteChrome } from "@/lib/site-chrome";
import { fmtDateTime } from "@/lib/admin/format";
import { AdminFlash } from "@/components/admin/admin-flash";
import { AdminFilterBar } from "@/components/admin/admin-filter-bar";
import { ChromeRowsEditor } from "@/components/admin/chrome-rows-editor";
import { Pagination } from "@/components/content/pagination";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  createAnnouncementAction,
  editAnnouncementAction,
  endAnnouncementAction,
  saveFooterAction,
  saveLinksAction,
  saveNavAction,
} from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "公告与站点框架" };

const PER_PAGE = 20;

type Params = {
  searchParams: Promise<Record<string, string | undefined>>;
};

function statusOf(a: { startsAt: string; endsAt: string | null }): {
  label: string;
  cls: string;
} {
  const now = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }); // "YYYY-MM-DD HH:mm:ss"
  if (a.endsAt !== null && a.endsAt <= now)
    return { label: "已结束", cls: "bg-muted text-muted-foreground" };
  if (a.startsAt > now) return { label: "未开始", cls: "bg-warning/10 text-warning" };
  return { label: "生效中", cls: "bg-success/10 text-success" };
}

/** 公告管理 + 站点框架（M9；M9.5 重做：编辑能力、分页、时间统一、状态徽标、导航/友链条目化）。 */
export default async function AdminAnnouncementsPage({ searchParams }: Params) {
  await requireAdmin();
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? "1") || 1);
  const status = sp.status === "active" || sp.status === "ended" ? sp.status : undefined;
  // 编辑模式：?edit=id 时顶部表单预填
  const editId = Number(sp.edit ?? "0") || null;

  const where =
    status === "ended"
      ? sql`${announcements.endsAt} IS NOT NULL AND ${announcements.endsAt} <= NOW()`
      : status === "active"
        ? or(isNull(announcements.endsAt), sql`${announcements.endsAt} > NOW()`)
        : undefined;

  const [countRow, rows, chrome] = await Promise.all([
    getWebDb().select({ n: count() }).from(announcements).where(where),
    getWebDb()
      .select()
      .from(announcements)
      .where(where)
      .orderBy(desc(announcements.id))
      .limit(PER_PAGE)
      .offset((page - 1) * PER_PAGE),
    getSiteChrome(),
  ]);
  const total = Number(countRow[0]?.n ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const editing = editId ? (rows.find((a) => a.id === editId) ?? null) : null;

  const flash = Object.entries({
    created: "公告已发布（铃铛对全部受众出现未读）。",
    updated: "公告已保存修改。",
    ended: "公告已下线。",
    nav: "导航已保存并即时生效。",
    links: "友链已保存并即时生效。",
    footer: "页脚已保存并即时生效。",
  }).find(([k]) => sp[k] === "1")?.[1];
  const flashErr = sp.err ?? sp.navErr ?? sp.linksErr ?? undefined;

  const baseQuery = (over: Record<string, string>) => {
    const p = new URLSearchParams();
    if (status) p.set("status", status);
    for (const [k, v] of Object.entries(over)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    const qs = p.toString();
    return `/admin/announcements${qs ? `?${qs}` : ""}`;
  };

  // datetime-local 预填值（DB "YYYY-MM-DD HH:MM:SS" → "YYYY-MM-DDTHH:MM"）
  const toLocalInput = (d: string | null) => (d ? d.replace(" ", "T").slice(0, 16) : "");

  return (
    <div className="space-y-4">
      {flashErr && (
        <AdminFlash kind="error" dismissHref={baseQuery({ err: "", navErr: "", linksErr: "" })}>
          {flashErr}
        </AdminFlash>
      )}
      {flash && (
        <AdminFlash
          kind="success"
          dismissHref={baseQuery({
            created: "",
            updated: "",
            ended: "",
            nav: "",
            links: "",
            footer: "",
          })}
        >
          {flash}
        </AdminFlash>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{editing ? `编辑公告 #${editing.id}` : "发布公告"}</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            action={editing ? editAnnouncementAction : createAnnouncementAction}
            className="space-y-3"
          >
            {editing && <input type="hidden" name="id" value={editing.id} />}
            <input
              name="title"
              required
              maxLength={200}
              placeholder="标题"
              defaultValue={editing?.title ?? ""}
              className="w-full rounded-lg border bg-background px-3 py-1.5 text-sm"
            />
            <textarea
              name="bodyMd"
              rows={4}
              maxLength={20_000}
              placeholder="正文（Markdown）"
              defaultValue={editing?.bodyMd ?? ""}
              className="w-full rounded-lg border bg-background px-3 py-1.5 text-sm"
            />
            <div className="flex flex-wrap gap-3 text-sm">
              <select
                name="level"
                aria-label="级别"
                defaultValue={editing?.level ?? "info"}
                className="rounded-lg border bg-background px-2.5 py-1.5"
              >
                <option value="info">普通</option>
                <option value="important">重要</option>
              </select>
              <select
                name="audience"
                aria-label="受众"
                defaultValue={editing?.audience ?? "all"}
                className="rounded-lg border bg-background px-2.5 py-1.5"
              >
                <option value="all">所有人（含游客）</option>
                <option value="members">仅登录会员</option>
              </select>
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  name="showBanner"
                  value="on"
                  defaultChecked={editing?.showBanner ?? false}
                />{" "}
                顶部横幅
              </label>
              <input
                type="datetime-local"
                name="startsAt"
                aria-label={editing ? "开始时间（留空保留原值）" : "开始时间（默认现在）"}
                defaultValue={toLocalInput(editing?.startsAt ?? null)}
                className="rounded-lg border bg-background px-2.5 py-1.5"
              />
              <input
                type="datetime-local"
                name="endsAt"
                aria-label="结束时间（空为长期）"
                defaultValue={toLocalInput(editing?.endsAt ?? null)}
                className="rounded-lg border bg-background px-2.5 py-1.5"
              />
            </div>
            <div className="flex items-center gap-2">
              <SubmitButton
                className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                pendingText={editing ? "保存中…" : "发布中…"}
              >
                {editing ? "保存修改" : "发布"}
              </SubmitButton>
              {editing && (
                <Link
                  href={baseQuery({ edit: "" })}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  取消编辑
                </Link>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center justify-between gap-2">
            <span>公告列表（共 {total} 条）</span>
            <AdminFilterBar action="/admin/announcements" resetHref="/admin/announcements">
              <select
                name="status"
                defaultValue={status ?? ""}
                aria-label="按状态筛选"
                className="rounded-lg border border-input bg-background px-2 py-1.5 text-sm"
              >
                <option value="">全部状态</option>
                <option value="active">生效中（含未开始）</option>
                <option value="ended">已结束</option>
              </select>
            </AdminFilterBar>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y">
            {rows.map((a) => {
              const st = statusOf(a);
              return (
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
                      <span className={`ml-2 rounded-full px-2 py-0.5 text-xs ${st.cls}`}>
                        {st.label}
                      </span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {a.audience === "all" ? "所有人" : "会员"} · {fmtDateTime(a.startsAt)} ~{" "}
                      {a.endsAt ? fmtDateTime(a.endsAt) : "长期"}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <Link
                      href={baseQuery({ edit: String(a.id) })}
                      className="text-xs text-primary hover:underline"
                    >
                      编辑
                    </Link>
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
                  </div>
                </li>
              );
            })}
            {rows.length === 0 && (
              <li className="py-4 text-center text-sm text-muted-foreground">暂无公告</li>
            )}
          </ul>
          <Pagination basePath={baseQuery({})} page={page} totalPages={totalPages} />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>导航项</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={saveNavAction} className="space-y-2">
              <ChromeRowsEditor
                name="navRaw"
                initialRows={chrome.nav}
                hrefPlaceholder="/f/951"
                addLabel="添加导航项"
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
              <ChromeRowsEditor
                name="linksRaw"
                initialRows={chrome.links}
                hrefPlaceholder="https://…"
                addLabel="添加友链"
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
