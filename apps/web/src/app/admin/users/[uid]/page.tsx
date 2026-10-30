import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/authz/require-admin";
import { checkPermission } from "@/lib/authz/service";
import { loadSubject } from "@/lib/authz/subject";
import { adminUserDetail } from "@/lib/authz/restrictions-admin";
import { listRoles } from "@/lib/authz/admin";
import { getLedgerPage } from "@/lib/points/ledger";
import { userBadgesOf } from "@/lib/badges/service";
import { getPointsName } from "@/lib/auth/settings";
import { fmtDateTime } from "@/lib/admin/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { ForumSelect } from "@/components/admin/forum-select";
import { Pagination } from "@/components/content/pagination";
import {
  assignRoleAction,
  createRestrictionAction,
  liftRestrictionAction,
  revokeRoleAction,
  revokeUserSessionAction,
} from "../actions";

export const dynamic = "force-dynamic";

type Params = {
  params: Promise<{ uid: string }>;
  searchParams: Promise<{
    error?: string;
    restricted?: string;
    lifted?: string;
    role?: string;
    session?: string;
    page?: string;
  }>;
};

const KIND_LABELS: Record<string, string> = {
  ban: "全站封禁",
  forum_ban: "板块禁入",
  mute: "禁言",
  no_avatar: "禁头像",
  no_signature: "禁签名",
};

/** 用户详情（M9，admin.users）：资料/积分台账/徽章/会话/限制管理/角色调整 */
export default async function AdminUserDetailPage({ params, searchParams }: Params) {
  const admin = await requireAdmin("admin.users");
  const uid = Number((await params).uid);
  if (!Number.isInteger(uid) || uid <= 0) notFound();
  const sp0 = await searchParams;
  const ledgerPage = Math.max(1, Number(sp0.page ?? "1") || 1);
  const adminSubject = await loadSubject(admin.userId);
  const canViewIp = (await checkPermission(adminSubject, "user.viewIp")).allowed;
  const [detail, roles, ledger, badges, pointsName] = await Promise.all([
    adminUserDetail(uid, canViewIp),
    listRoles(),
    getLedgerPage(uid, ledgerPage),
    userBadgesOf(uid),
    getPointsName(),
  ]);
  if (!detail) notFound();
  const closurePending = detail.closureRequest?.status === "pending";
  const closureCompleted = detail.closureRequest?.status === "completed";
  const lifecycleReadOnly = detail.state === "deleted" || closurePending || closureCompleted;
  const lifecycleLabel =
    detail.state === "deleted" || closureCompleted
      ? "已注销"
      : closurePending
        ? "注销申请中"
        : "活跃";
  const sp = sp0;

  return (
    <div className="space-y-4">
      {sp.error && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {sp.error}
        </p>
      )}
      {sp.restricted && (
        <p className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
          限制已生效（当事人会收到通知）。
        </p>
      )}
      {sp.lifted && (
        <p className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
          限制已解除（当事人会收到通知）。
        </p>
      )}
      {sp.role && (
        <p className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
          角色已更新。
        </p>
      )}
      {sp.session === "revoked" && (
        <p className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
          会话已吊销。
        </p>
      )}

      <AdminPageHeader
        back="/admin/users"
        backLabel="返回用户管理"
        title={detail.username}
        stats={`uid ${detail.id}`}
      />

      {lifecycleReadOnly && (
        <p className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
          {closurePending
            ? `账号处于私密注销冷静期，计划完成时间：${detail.closureRequest?.scheduledAt ?? "未记录"}。不能新增角色或限制；现有授权仍可按治理流程撤销。`
            : "账号已注销，治理页面仅供查看和清理残留授权。"}
        </p>
      )}

      <Card>
        <CardContent className="flex flex-wrap gap-x-8 gap-y-1 pt-6 text-sm">
          <span className="font-medium">{lifecycleLabel}</span>
          <span className="text-muted-foreground">{detail.email ?? "（无邮箱）"}</span>
          <span className={detail.emailVerifiedAt ? "text-success" : "text-warning"}>
            {detail.emailVerifiedAt
              ? "邮箱已验证"
              : detail.emailVerificationRequired
                ? "邮箱待验证（写入受限）"
                : "邮箱未验证（账号未要求验证）"}
          </span>
          <span className="text-muted-foreground">
            {detail.hasPassword ? "已设置密码" : "无密码 / 待认领"}
          </span>
          {detail.legacyPasswordPending && <span className="text-warning">旧密码待强制换新</span>}
          <span className="text-muted-foreground">注册于 {fmtDateTime(detail.createdAt)}</span>
          <span className="text-muted-foreground">
            最近登录 {detail.lastLoginAt ? fmtDateTime(detail.lastLoginAt) : "从未"}
          </span>
          <span>
            {pointsName} {detail.points ?? 0}
          </span>
          {detail.state === "active" && (
            <Link href={`/u/${detail.id}`} className="text-primary hover:underline">
              公开资料 →
            </Link>
          )}
          {detail.closureRequest && (
            <span className="text-muted-foreground">
              注销记录：
              {detail.closureRequest.status === "pending"
                ? `申请 ${fmtDateTime(detail.closureRequest.requestedAt)}，计划 ${fmtDateTime(detail.closureRequest.scheduledAt)}`
                : detail.closureRequest.status === "completed"
                  ? "已完成"
                  : `已撤销（${fmtDateTime(detail.closureRequest.requestedAt)}）`}
            </span>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* 限制管理 */}
        <Card>
          <CardHeader>
            <CardTitle>限制管理</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {!lifecycleReadOnly && (
              <form action={createRestrictionAction} className="space-y-2">
                <input type="hidden" name="userId" value={detail.id} />
                <div className="flex flex-wrap gap-2">
                  <select
                    name="kind"
                    className="rounded-lg border bg-background px-2.5 py-1.5 text-sm"
                    aria-label="限制类型"
                  >
                    {Object.entries(KIND_LABELS).map(([k, label]) => (
                      <option key={k} value={k}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <ForumSelect
                    name="scopeId"
                    label="限制范围"
                    defaultValue={0}
                    globalLabel="全站"
                    className="rounded-lg border bg-background px-2.5 py-1.5 text-sm"
                  />
                  <input
                    type="datetime-local"
                    name="endsAt"
                    aria-label="结束时间（北京时间，空为永久）"
                    className="rounded-lg border bg-background px-2.5 py-1.5 text-sm"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  全站封禁和头像/签名限制只能选全站；板块禁入作用于所选板块及子树，禁言可选全站或板块。结束时间按北京时间输入。
                </p>
                <input
                  name="reason"
                  required
                  maxLength={255}
                  placeholder="理由（必填，写入审计与通知）"
                  className="w-full rounded-lg border bg-background px-2.5 py-1.5 text-sm"
                />
                <ConfirmSubmit
                  title="施加限制"
                  description="确认对该用户施加所选限制？"
                  className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                  pendingText="…"
                >
                  施加限制
                </ConfirmSubmit>
              </form>
            )}

            {detail.restrictions.length > 0 ? (
              <ul className="space-y-2 border-t pt-3">
                {detail.restrictions.map((r) => (
                  <li key={r.id} className="text-sm">
                    <p>
                      <span className="font-medium">{KIND_LABELS[r.kind] ?? r.kind}</span>（
                      {r.scopeId === 0 ? "全站" : `板块 ${r.scopeId} 及子树`}，
                      {fmtDateTime(r.startsAt)} ~ {r.endsAt ? fmtDateTime(r.endsAt) : "永久"}）：
                      {r.reason}
                      {!r.active && (
                        <span className="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                          已过期
                        </span>
                      )}
                    </p>
                    {r.active && (
                      <form action={liftRestrictionAction} className="mt-1 flex gap-1">
                        <input type="hidden" name="restrictionId" value={r.id} />
                        <input type="hidden" name="userId" value={detail.id} />
                        <input
                          name="note"
                          required
                          maxLength={255}
                          placeholder="解除说明（必填）"
                          className="w-52 rounded-lg border bg-background px-2.5 py-1 text-xs"
                        />
                        <ConfirmSubmit
                          title="解除限制"
                          description="确认解除该用户的限制？"
                          className="rounded-lg border px-2.5 py-1 text-xs hover:bg-accent disabled:opacity-60"
                          pendingText="…"
                        >
                          解除
                        </ConfirmSubmit>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="border-t pt-3 text-sm text-muted-foreground">当前没有限制记录。</p>
            )}
          </CardContent>
        </Card>

        {/* 角色调整 */}
        <Card>
          <CardHeader>
            <CardTitle>角色</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <ul className="space-y-1 text-sm">
              {detail.roles.map((r) => (
                <li key={`${r.roleKey}:${r.scopeId}`} className="flex items-center justify-between">
                  <span>
                    {r.roleKey}
                    {r.scopeId > 0 ? `（板块 ${r.scopeId}）` : ""}
                    {r.expiresAt ? ` 至 ${r.expiresAt}` : " · 永久"}
                    <span className={r.active ? "ml-1 text-success" : "ml-1 text-muted-foreground"}>
                      {r.active ? "生效中" : "已过期"}
                    </span>
                    <span className="ml-1 text-xs text-muted-foreground">
                      授予于 {fmtDateTime(r.grantedAt)}
                    </span>
                  </span>
                  <form action={revokeRoleAction}>
                    <input type="hidden" name="userId" value={detail.id} />
                    <input type="hidden" name="roleKey" value={r.roleKey} />
                    <input type="hidden" name="scopeId" value={r.scopeId} />
                    <input
                      name="reason"
                      required
                      maxLength={255}
                      placeholder="撤销理由"
                      className="w-36 rounded-lg border bg-background px-2 py-1 text-xs"
                    />
                    <ConfirmSubmit
                      title="撤销角色"
                      description="确认撤销该用户的角色？"
                      className="text-xs text-destructive hover:underline disabled:opacity-60"
                      pendingText="…"
                    >
                      撤销
                    </ConfirmSubmit>
                  </form>
                </li>
              ))}
              {detail.roles.length === 0 && (
                <li className="text-sm text-muted-foreground">
                  仅隐式 member/guest（无显式角色绑定）
                </li>
              )}
            </ul>
            {!lifecycleReadOnly && (
              <form action={assignRoleAction} className="flex flex-wrap gap-2 border-t pt-3">
                <input type="hidden" name="userId" value={detail.id} />
                <select
                  name="roleKey"
                  aria-label="角色"
                  className="rounded-lg border bg-background px-2.5 py-1.5 text-sm"
                >
                  {roles.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.name}
                    </option>
                  ))}
                </select>
                <ForumSelect
                  name="scopeId"
                  label="板块作用域（全局或具体板块）"
                  defaultValue={0}
                  allLabel="全局"
                />
                <input
                  name="reason"
                  required
                  maxLength={255}
                  placeholder="授予理由"
                  className="min-w-48 flex-1 rounded-lg border bg-background px-2.5 py-1.5 text-sm"
                />
                <label className="grid gap-1 text-xs text-muted-foreground">
                  到期时间（北京时间，空为永久）
                  <input
                    name="expiresAt"
                    type="datetime-local"
                    className="rounded-lg border bg-background px-2.5 py-1.5 text-sm text-foreground"
                  />
                </label>
                <SubmitButton
                  className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                  pendingText="…"
                >
                  授予
                </SubmitButton>
              </form>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>最近会话</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm text-muted-foreground">
              {detail.sessions.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-2">
                  <span>
                    {s.lastSeenAt ?? s.createdAt} · {s.active ? "有效" : "已过期"}
                    （到期 {fmtDateTime(s.expiresAt)}） ·{" "}
                    {s.ip ?? (canViewIp ? "无 IP" : "IP 无查看权限")}
                  </span>
                  {s.active && (
                    <form action={revokeUserSessionAction}>
                      <input type="hidden" name="userId" value={detail.id} />
                      <input type="hidden" name="sessionId" value={s.id} />
                      <ConfirmSubmit
                        title="吊销会话"
                        description="确认吊销该设备会话？后续请求将立即要求重新登录。"
                        className="text-xs text-destructive hover:underline disabled:opacity-60"
                        pendingText="…"
                      >
                        吊销
                      </ConfirmSubmit>
                    </form>
                  )}
                </li>
              ))}
              {detail.sessions.length === 0 && <li>无活跃会话记录</li>}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{pointsName}台账</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm text-muted-foreground">
              {ledger.items.map((l) => (
                <li key={l.id} className="flex items-baseline gap-2">
                  <span className="whitespace-nowrap">{fmtDateTime(l.createdAt)}</span>
                  <span>{l.channel}</span>
                  <span className={l.delta > 0 ? "text-success" : "text-destructive"}>
                    {l.delta > 0 ? `+${l.delta}` : l.delta}
                  </span>
                  <span className="min-w-0 truncate">{l.note}</span>
                </li>
              ))}
              {ledger.items.length === 0 && <li>无台账记录</li>}
            </ul>
            <Pagination
              basePath={`/admin/users/${detail.id}`}
              page={ledger.page}
              totalPages={ledger.totalPages}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>徽章（{badges.length}）</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {badges.length > 0 ? badges.map((b) => b.name).join("、") : "暂无徽章"}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>最近治理审计</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {detail.audit.map((entry) => (
              <li key={entry.id}>
                {fmtDateTime(entry.createdAt)} · {entry.action} · 操作者 uid{" "}
                {entry.actorId ?? "系统"}
              </li>
            ))}
            {detail.audit.length === 0 && <li>暂无治理审计记录</li>}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
