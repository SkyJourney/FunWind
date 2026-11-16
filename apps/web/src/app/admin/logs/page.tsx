import Link from "next/link";
import { requireAdmin } from "@/lib/authz/require-admin";
import {
  listAuditTargetTypes,
  queryAuditLogs,
  queryEventLogs,
  resolveActorId,
} from "@/lib/admin/logs";
import { pageBounds } from "@/lib/paging";
import {
  buildAdminQuery,
  densityCellClass,
  parseAdminListParams,
  parseAdminPage,
} from "@/lib/admin/query";
import { JsonViewerButton } from "@/components/admin/json-viewer";
import { AdminFilterSelect, AdminListPager, AdminTable } from "@/components/admin/admin-list";
import { AdminFilterBar } from "@/components/admin/admin-filter-bar";
import { AdminDateRange } from "@/components/admin/admin-date-range";
import { AdminFlash } from "@/components/admin/admin-flash";
import { UserPicker } from "@/components/admin/user-picker";

export const dynamic = "force-dynamic";
export const metadata = { title: "审计日志" };

type Params = {
  searchParams: Promise<{
    tab?: string;
    action?: string;
    actor?: string;
    targetType?: string;
    from?: string;
    to?: string;
    size?: string;
    density?: string;
    page?: string;
  }>;
};

/**
 * 审计日志中心（M9，admin.logs；M19 S4 升级）：audit_log + event_log 双 tab，
 * action/actor（UserPicker，用户名或 uid）/目标类型（audit）/日期范围筛选 + 每页条数与密度切换 + CSV 导出。
 */
export default async function AdminLogsPage({ searchParams }: Params) {
  await requireAdmin("admin.logs");
  const sp = await searchParams;
  const tab = sp.tab === "events" ? "events" : "audit";
  const action = typeof sp.action === "string" && sp.action ? sp.action : undefined;
  const targetType = tab === "audit" && sp.targetType ? sp.targetType : undefined;
  const { size, density, from, to } = parseAdminListParams(sp);
  const page = parseAdminPage(sp.page, "number-or-one");
  // actor 支持「用户名或 uid」：用户名精确反查；查不到时用 -1 哨兵强制空结果并给出提示（不静默变全量）
  const actorRaw = typeof sp.actor === "string" && sp.actor ? sp.actor : undefined;
  const actorId = actorRaw ? await resolveActorId(actorRaw) : undefined;
  const actorMissing = Boolean(actorRaw) && actorId === undefined;

  const filter = {
    action,
    actorId: actorMissing ? -1 : actorId,
    since: from,
    until: to ? `${to} 23:59:59` : undefined,
    targetType,
    limit: size,
    page,
  };
  const result = tab === "events" ? await queryEventLogs(filter) : await queryAuditLogs(filter);
  const { page: safePage, totalPages } = pageBounds(result.total, page, size);
  const targetTypes = tab === "audit" ? await listAuditTargetTypes() : [];

  const query = {
    ...(tab !== "audit" ? { tab } : {}),
    ...(action ? { action } : {}),
    ...(actorRaw ? { actor: actorRaw } : {}),
    ...(targetType ? { targetType } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(size !== 20 ? { size } : {}),
    ...(density !== "cozy" ? { density } : {}),
  };
  const baseQuery = (over: Record<string, string | number | undefined> = {}) =>
    buildAdminQuery("/admin/logs", query, over);

  const cell = densityCellClass(density);
  const csvHref = buildAdminQuery(`/api/admin/logs/csv`, {
    ...(tab !== "audit" ? { tab } : {}),
    ...(action ? { action } : {}),
    ...(actorId ? { actor: actorId } : {}),
    ...(targetType ? { targetType } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <nav className="flex gap-2 text-sm" aria-label="日志类型">
          <Link
            href="/admin/logs"
            className={`rounded-full border px-3 py-1 ${tab === "audit" ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
          >
            审计日志
          </Link>
          <Link
            href="/admin/logs?tab=events"
            className={`rounded-full border px-3 py-1 ${tab === "events" ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
          >
            事件日志
          </Link>
        </nav>
        <Link href={csvHref} className="text-xs text-primary hover:underline" prefetch={false}>
          导出 CSV
        </Link>
      </div>

      {actorMissing && (
        <AdminFlash kind="info">查无此 actor：{actorRaw}（请输入用户名或数字 uid）。</AdminFlash>
      )}

      <AdminFilterBar
        action="/admin/logs"
        resetHref={tab === "events" ? "/admin/logs?tab=events" : "/admin/logs"}
        placeholder={tab === "events" ? "事件名（如 thread.created）" : "动作（如 points.adjust）"}
        keywordName="action"
        defaultValue={action ?? ""}
        hidden={{
          tab: tab !== "audit" ? tab : undefined,
          from,
          to,
          targetType: tab === "audit" ? targetType : undefined,
        }}
        total={<span className="ml-auto text-xs text-muted-foreground">共 {result.total} 条</span>}
      >
        <UserPicker
          name="actor"
          label="actor（用户名或 uid）"
          defaultValue={actorRaw ?? ""}
          placeholder="actor：用户名 / uid"
        />
        {tab === "audit" && (
          <AdminFilterSelect
            name="targetType"
            label="按目标类型筛选"
            allLabel="全部目标"
            value={targetType ?? ""}
            options={targetTypes.map((t) => ({ value: t, label: t }))}
          />
        )}
        <AdminDateRange from={from} to={to} />
      </AdminFilterBar>

      <AdminListPager
        total={result.total}
        page={safePage}
        totalPages={totalPages}
        basePath={baseQuery({})}
        controls={{
          action: "/admin/logs",
          current: { ...query, page: undefined },
          size,
          density,
        }}
      />

      <AdminTable
        colSpan={6}
        hasRows={result.items.length > 0}
        head={
          <>
            <th className="px-3 py-2">id</th>
            <th className="px-3 py-2">时间</th>
            <th className="px-3 py-2">{tab === "events" ? "事件名" : "动作"}</th>
            <th className="px-3 py-2">actor</th>
            {tab === "audit" ? (
              <>
                <th className="hidden px-3 py-2 md:table-cell">目标</th>
                <th className="hidden px-3 py-2 sm:table-cell">详情</th>
              </>
            ) : (
              <th className="px-3 py-2">source / 错误</th>
            )}
          </>
        }
        rows={
          tab === "audit"
            ? (result as Awaited<ReturnType<typeof queryAuditLogs>>).items.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className={`${cell} tabular-nums`}>{r.id}</td>
                  <td className={`${cell} whitespace-nowrap`}>{r.createdAt}</td>
                  <td className={`${cell} font-mono`}>{r.action}</td>
                  <td className={`${cell} tabular-nums`}>{r.actorId ?? "—"}</td>
                  <td className={`hidden ${cell} md:table-cell`}>
                    {r.targetType}:{r.targetId}
                  </td>
                  <td className={`hidden ${cell} sm:table-cell`}>
                    <JsonViewerButton label="查看" json={r.afterJson ?? r.beforeJson ?? {}} />
                  </td>
                </tr>
              ))
            : (result as Awaited<ReturnType<typeof queryEventLogs>>).items.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className={`${cell} tabular-nums`}>{r.id}</td>
                  <td className={`${cell} whitespace-nowrap`}>{r.createdAt}</td>
                  <td className={`${cell} font-mono`}>{r.eventName}</td>
                  <td className={`${cell} tabular-nums`}>{r.actorId ?? "—"}</td>
                  <td className={cell}>
                    {r.source ?? "—"}
                    {r.errorJson ? <span className="ml-1 text-destructive">（有错误）</span> : null}
                  </td>
                </tr>
              ))
        }
      />
      <p className="text-xs text-muted-foreground md:hidden">
        窄屏隐藏「目标/详情」列，完整数据请导出 CSV。
      </p>
    </div>
  );
}
