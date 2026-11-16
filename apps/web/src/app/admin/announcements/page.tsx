import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import Link from "next/link";
import { and, count, desc, isNull, or, sql } from "drizzle-orm";
import { announcements, getWebDb } from "@funwind/db";
import { requireAdmin } from "@/lib/authz/require-admin";
import { fmtDateTime } from "@/lib/admin/format";
import { buildAdminQuery, parseAdminListParams, parseAdminPage } from "@/lib/admin/query";
import { pageBounds } from "@/lib/paging";
import { AdminFlash } from "@/components/admin/admin-flash";
import { AdminFilterBar } from "@/components/admin/admin-filter-bar";
import { AdminListPager } from "@/components/admin/admin-list";
import { flashText } from "@/lib/admin/flash";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { Megaphone } from "lucide-react";
import { SubmitButton } from "@/components/ui/submit-button";
import { createAnnouncementAction, editAnnouncementAction, endAnnouncementAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "公告" };

type Params = {
  searchParams: Promise<Record<string, string | undefined>>;
};

/** 回执键 → 文案（M19 Q5） */
const ANNOUNCEMENTS_OK: Record<string, string> = {
  created: "公告已发布（铃铛对全部受众出现未读）。",
  updated: "公告已保存修改。",
  ended: "公告已下线。",
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

/** 公告管理（M9；M9.5 重做：编辑能力、分页、时间统一、状态徽标。M19 Q3：站点框架迁至
 *  /admin/settings；S4 加标题关键词与每页条数）。 */
export default async function AdminAnnouncementsPage({ searchParams }: Params) {
  await requireAdmin();
  const sp = await searchParams;
  const requestedPage = parseAdminPage(sp.page, "number-or-one");
  const status = sp.status === "active" || sp.status === "ended" ? sp.status : undefined;
  const q = typeof sp.q === "string" && sp.q ? sp.q : undefined;
  const { size } = parseAdminListParams(sp);
  // 编辑模式：?edit=id 时顶部表单预填
  const editId = Number(sp.edit ?? "0") || null;

  const statusWhere =
    status === "ended"
      ? sql`${announcements.endsAt} IS NOT NULL AND ${announcements.endsAt} <= NOW()`
      : status === "active"
        ? or(isNull(announcements.endsAt), sql`${announcements.endsAt} > NOW()`)
        : undefined;
  const where = q ? and(statusWhere, sql`${announcements.title} LIKE ${`%${q}%`}`) : statusWhere;

  const [countRow] = await getWebDb().select({ n: count() }).from(announcements).where(where);
  const total = Number(countRow?.n ?? 0);
  const { page, totalPages, offset } = pageBounds(total, requestedPage, size);
  const rows = await getWebDb()
    .select()
    .from(announcements)
    .where(where)
    .orderBy(desc(announcements.id))
    .limit(size)
    .offset(offset);
  const editing = editId ? (rows.find((a) => a.id === editId) ?? null) : null;

  const flash = flashText(ANNOUNCEMENTS_OK, sp.ok);
  const flashErr = sp.err ?? undefined;

  const query = {
    ...(status ? { status } : {}),
    ...(q ? { q } : {}),
    ...(size !== 20 ? { size } : {}),
  };
  const baseQuery = (over: Record<string, string> = {}) =>
    buildAdminQuery("/admin/announcements", query, over);

  // datetime-local 预填值（DB "YYYY-MM-DD HH:MM:SS" → "YYYY-MM-DDTHH:MM"）
  const toLocalInput = (d: string | null) => (d ? d.replace(" ", "T").slice(0, 16) : "");

  return (
    <div className="space-y-4">
      {flashErr && (
        <AdminFlash kind="error" dismissHref={baseQuery({ err: "" })}>
          {flashErr}
        </AdminFlash>
      )}
      {flash && (
        <AdminFlash kind="success" dismissHref={baseQuery({ created: "", updated: "", ended: "" })}>
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
                <span className="text-xs text-muted-foreground">
                  （勾选即在全站顶部展示该公告的横幅，点击标题进详情页；同一时刻只显示最新一条带横幅的公告——取消勾选即下线）
                </span>
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
            <AdminFilterBar
              action="/admin/announcements"
              resetHref="/admin/announcements"
              placeholder="标题关键词"
              defaultValue={q ?? ""}
            >
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
            {rows.length === 0 && <EmptyState icon={Megaphone} title="暂无公告。" />}
          </ul>
          <AdminListPager
            total={total}
            page={page}
            totalPages={totalPages}
            basePath={baseQuery({})}
            controls={{ action: "/admin/announcements", current: query, size }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
