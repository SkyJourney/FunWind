import { notFound } from "next/navigation";
import Link from "next/link";
import { requireAdmin } from "@/lib/authz/require-admin";
import {
  ADMIN_API_TOKEN_DAYS,
  ADMIN_API_TOKEN_DEFAULT_DAYS,
  ADMIN_API_TOKEN_LIMIT,
  getAssignableManageEndpointIds,
  isEffectiveSiteAdminOf,
  listAdminApiTokens,
  takePlainOnce,
  type AdminApiTokenListItem,
} from "@/lib/manage/tokens";
import {
  getManageEndpoint,
  MANAGE_ENDPOINTS,
  MANAGE_PERMISSION_DOMAINS,
  type ManageEndpointId,
  type ManagePermissionDomain,
} from "@/lib/manage/permissions";
import { flashText } from "@/lib/admin/flash";
import { AdminFlash } from "@/components/admin/admin-flash";
import { CopyCode } from "@/components/admin/copy-code";
import { AdminDataTable, type AdminCell, type AdminColumn } from "@/components/admin/admin-list";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { SubmitButton } from "@/components/ui/submit-button";
import { createApiTokenAction, revokeApiTokenAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "API 令牌" };

/** 回执键 → 文案（M19 Q5；err 允许注册表码或 AdminError 裸文案直达） */
const TOKENS_OK: Record<string, string> = {
  revoked: "Token 已吊销，使用它的调用即刻失效（401）。",
};
const TOKENS_ERR: Record<string, string> = {
  "already-revoked": "该 Token 已吊销过，无需重复操作。",
  "rate-limited": "签发过于频繁，请稍后再试。",
  "invalid-fields": "签发表单包含不受支持的字段，请重新提交。",
};

const DOMAINS = Object.keys(MANAGE_PERMISSION_DOMAINS) as ManagePermissionDomain[];
const ENDPOINT_IDS = Object.keys(MANAGE_ENDPOINTS) as ManageEndpointId[];

const COLUMNS: AdminColumn[] = [
  { label: "名称", className: "" },
  { label: "尾号", className: "font-mono" },
  { label: "创建时间", className: "whitespace-nowrap hidden md:table-cell" },
  { label: "过期时间", className: "whitespace-nowrap hidden md:table-cell" },
  { label: "最后使用", className: "whitespace-nowrap hidden lg:table-cell" },
  { label: "授权", className: "" },
  { label: "状态", className: "" },
  { label: "操作", className: "" },
];

/** 状态徽标（users 页胶囊形态：rounded-full px-2 py-0.5） */
function statusBadgeOf(t: AdminApiTokenListItem) {
  if (t.revokedAt !== null)
    return <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">已吊销</span>;
  if (!t.active)
    return <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">已过期</span>;
  if (t.endpointGrants === null)
    return <span className="rounded-full bg-warning/10 px-2 py-0.5 text-warning">不可用</span>;
  return <span className="rounded-full bg-success/10 px-2 py-0.5 text-success">生效中</span>;
}

/** 只允许授予持有人具备的整档端点；提交后仍以服务端重新检查为准。 */
function PermissionMatrix({ assignableIds }: { assignableIds: readonly ManageEndpointId[] }) {
  const assignable = new Set(assignableIds);
  return (
    <fieldset className="min-w-0 space-y-2">
      <legend className="font-medium">权限矩阵</legend>
      <p className="text-xs text-muted-foreground">
        所有域默认禁止，签发时至少选择一项可用权限。只读包含所选域的读端点，读写同时包含读、写端点；实际调用仍受持有人的实时权限和资源范围限制。
      </p>
      <div className="divide-y rounded-lg border">
        {DOMAINS.map((domain) => {
          const endpoints = ENDPOINT_IDS.filter((id) => getManageEndpoint(id).domain === domain);
          const reads = endpoints.filter((id) => getManageEndpoint(id).access === "read");
          const hasWrites = endpoints.some((id) => getManageEndpoint(id).access === "write");
          const canRead = reads.length > 0 && reads.every((id) => assignable.has(id));
          const canWrite = hasWrites && endpoints.every((id) => assignable.has(id));
          const hint = [
            canRead ? "" : reads.length === 0 ? "尚无读端点。" : "权限不足，不能选只读。",
            canWrite ? "" : !hasWrites ? "尚无写端点。" : "权限不足，不能选读写。",
          ].join("");
          const fieldId = `permission-${domain}`;
          return (
            <div
              key={domain}
              className="grid min-w-0 gap-2 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_8rem] sm:items-center"
            >
              <div className="min-w-0">
                <label htmlFor={fieldId} className="font-medium">
                  {MANAGE_PERMISSION_DOMAINS[domain]}
                </label>
                {hint && (
                  <p id={`${fieldId}-hint`} className="mt-0.5 text-xs text-muted-foreground">
                    {hint}
                  </p>
                )}
              </div>
              <select
                id={fieldId}
                name={`permission.${domain}`}
                aria-describedby={hint ? `${fieldId}-hint` : undefined}
                defaultValue="none"
                className="w-full min-w-0 rounded-lg border bg-background px-2.5 py-1.5"
              >
                <option value="none">禁止</option>
                <option value="read" disabled={!canRead}>
                  只读
                </option>
                <option value="write" disabled={!canWrite}>
                  读写
                </option>
              </select>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

/** 按签发时的快照列出端点，不从域级档位反推已授权能力。 */
function TokenPermissions({ token }: { token: AdminApiTokenListItem }) {
  const grants = token.endpointGrants;
  if (grants === null) return <span className="font-medium text-warning">授权异常</span>;

  const profile = token.permissionProfile === "legacy_m20_read" ? "旧版 · 固定九读" : "新版 · 快照";
  const grantSet = new Set(grants);
  const ungrantedCount = ENDPOINT_IDS.filter((id) => !grantSet.has(id)).length;
  return (
    <details className="text-xs">
      <summary className="cursor-pointer rounded-sm font-medium">
        {profile} · {grants.length} 个端点
      </summary>
      <div className="mt-2 space-y-2">
        {DOMAINS.map((domain) => {
          const domainGrants = grants.filter((id) => getManageEndpoint(id).domain === domain);
          if (domainGrants.length === 0) return null;
          return (
            <div key={domain}>
              <p className="font-medium">{MANAGE_PERMISSION_DOMAINS[domain]}</p>
              <ul className="mt-1 space-y-0.5 text-muted-foreground">
                {domainGrants.map((id) => {
                  const { method, path, access } = getManageEndpoint(id);
                  return (
                    <li key={id}>
                      <span className="mr-1">{access === "read" ? "读" : "写"} ·</span>
                      <code className="font-mono [overflow-wrap:anywhere]">
                        {method} {path}
                      </code>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
        <p className="text-muted-foreground">
          {ungrantedCount > 0 ? `当前目录中另有 ${ungrantedCount} 个端点未授权。` : ""}
          授权不会随目录变化而扩大。
        </p>
      </div>
    </details>
  );
}

/**
 * API 令牌管理（M20）：管理员自签/自管 Access Token（/api/manage/** 的 Bearer 凭证）。
 * 页面在 requireAdmin 之外追加站点管理员不变量校验（与 API 资格口径一致）；
 * 签发明文一次性展示（Service 层暂存，取走即删），明文不进 URL/cookie/日志。
 */
export default async function AdminApiTokensPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const admin = await requireAdmin("site.admin");
  if (!(await isEffectiveSiteAdminOf(admin.userId))) notFound();

  const [sp, tokens, assignableIds] = await Promise.all([
    searchParams,
    listAdminApiTokens(admin.userId),
    getAssignableManageEndpointIds(admin.userId),
  ]);
  // 一次性明文：?created=<id> 命中暂存则展示并立即失效（刷新/转发不重放）
  const freshPlain =
    typeof sp.created === "string" && sp.created ? takePlainOnce(sp.created, admin.userId) : null;

  const flash = flashText(TOKENS_OK, sp.ok);
  const flashErr =
    typeof sp.err === "string" && sp.err ? (flashText(TOKENS_ERR, sp.err) ?? sp.err) : undefined;
  const baseQuery = (over: Record<string, string> = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(over)) {
      if (v !== "") params.set(k, v);
    }
    const qs = params.toString();
    return qs ? `/admin/api-tokens?${qs}` : "/admin/api-tokens";
  };

  return (
    <div className="space-y-4">
      {flashErr && (
        <AdminFlash kind="error" dismissHref={baseQuery({ err: "" })}>
          {flashErr}
        </AdminFlash>
      )}
      {flash && (
        <AdminFlash kind="success" dismissHref={baseQuery({ ok: "" })}>
          {flash}
        </AdminFlash>
      )}

      {freshPlain && (
        <div
          data-testid="fresh-token"
          className="space-y-2 rounded-lg border border-warning/40 bg-warning/10 p-4"
        >
          <p className="text-sm font-medium">请立即保存这枚 Token——离开本页后无法再次查看：</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 rounded bg-background px-3 py-2 font-mono text-sm break-all select-all">
              {freshPlain}
            </code>
            <CopyCode code={freshPlain} ariaLabel="复制 Token 明文" />
          </div>
          <p className="text-xs text-muted-foreground">
            这是唯一一次展示（库内只存哈希，遗失只能吊销重签）；刷新或转发本页都不会再显示。
          </p>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>签发新 Token</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={createApiTokenAction} className="space-y-4 text-sm">
            <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
              <label className="min-w-0 space-y-1">
                <span className="block text-muted-foreground">名称（便于辨识用途）</span>
                <input
                  name="name"
                  required
                  maxLength={64}
                  placeholder="如：CI 脚本 / 本地 MCP"
                  className="w-full min-w-0 rounded-lg border bg-background px-3 py-1.5"
                />
              </label>
              <label className="min-w-0 space-y-1">
                <span className="block text-muted-foreground">有效期</span>
                <select
                  name="days"
                  defaultValue={String(ADMIN_API_TOKEN_DEFAULT_DAYS)}
                  className="w-full min-w-0 rounded-lg border bg-background px-2.5 py-1.5"
                >
                  {ADMIN_API_TOKEN_DAYS.map((d) => (
                    <option key={d} value={d}>
                      {d} 天
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <PermissionMatrix assignableIds={assignableIds} />
            <p className="text-xs text-muted-foreground">
              授权以签发时的端点为准，不会自动包含后续新增端点，也不能原地修改；如需变更，请签发新令牌后吊销旧令牌。
            </p>
            <SubmitButton pendingText="签发中…">签发</SubmitButton>
          </form>
          <p className="mt-2 text-xs text-muted-foreground">
            每管理员最多 {ADMIN_API_TOKEN_LIMIT} 个有效 Token。Token 以{" "}
            <code className="font-mono">Authorization: Bearer</code> 调用{" "}
            <code className="font-mono">/api/manage/**</code>；持有人被撤下管理员 / 全站封禁 /
            申请注销时全部 Token 同步吊销。
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            全部端点的入参 / 返回示例与错误码说明，见{" "}
            <Link
              href="/docs/rest-api"
              target="_blank"
              rel="noopener"
              className="text-primary hover:underline"
            >
              REST API 文档
            </Link>
            （独立页面，新窗口打开）。
          </p>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <p>
          共 {tokens.length} 个 Token（上限 {ADMIN_API_TOKEN_LIMIT}） · 生效{" "}
          {tokens.filter((t) => t.active && t.endpointGrants !== null).length} 个
        </p>
        <p>
          调用方式：<code className="font-mono">Authorization: Bearer &lt;token&gt;</code> →{" "}
          <code className="font-mono">/api/manage/**</code>
        </p>
      </div>

      <AdminDataTable
        columns={COLUMNS}
        hasRows={tokens.length > 0}
        emptyText="还没有签发过 Token。"
        rows={tokens.map((t) => {
          const cells: AdminCell[] = [
            {
              cls: "max-w-40 font-medium [overflow-wrap:anywhere] lg:max-w-56",
              node: <div title={t.name}>{t.name}</div>,
            },
            { cls: "font-mono", node: t.suffix },
            { cls: "whitespace-nowrap hidden md:table-cell", node: t.createdAt },
            { cls: "whitespace-nowrap hidden md:table-cell", node: t.expiresAt },
            {
              cls: "whitespace-nowrap hidden lg:table-cell",
              node: t.lastUsedAt ? (
                <span title={t.lastUsedIp ?? undefined}>{t.lastUsedAt}</span>
              ) : (
                "—"
              ),
            },
            { cls: "min-w-24 max-w-80", node: <TokenPermissions token={t} /> },
            { cls: "text-xs whitespace-nowrap", node: statusBadgeOf(t) },
            {
              cls: "whitespace-nowrap",
              node:
                t.revokedAt === null && (t.active || t.endpointGrants === null) ? (
                  <form action={revokeApiTokenAction}>
                    <input type="hidden" name="tokenId" value={t.id} />
                    <ConfirmSubmit
                      title="吊销 Token"
                      description={`吊销「${t.name}」（尾号 ${t.suffix}）后，使用它的脚本将立即收到 401。此操作不可恢复。`}
                      pendingText="吊销中…"
                      className="text-destructive hover:text-destructive"
                    >
                      吊销
                    </ConfirmSubmit>
                  </form>
                ) : (
                  <span className="text-muted-foreground">—</span>
                ),
            },
          ];
          return { key: t.id, cells };
        })}
      />
    </div>
  );
}
