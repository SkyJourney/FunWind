import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/authz/require-admin";
import {
  ADMIN_API_TOKEN_DAYS,
  ADMIN_API_TOKEN_DEFAULT_DAYS,
  ADMIN_API_TOKEN_LIMIT,
  isEffectiveSiteAdminOf,
  listAdminApiTokens,
  takePlainOnce,
  type AdminApiTokenListItem,
} from "@/lib/manage/tokens";
import { flashText } from "@/lib/admin/flash";
import { AdminFlash } from "@/components/admin/admin-flash";
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
};

function statusBadgeOf(t: AdminApiTokenListItem): { label: string; cls: string } {
  if (t.revokedAt !== null) return { label: "已吊销", cls: "bg-muted text-muted-foreground" };
  if (!t.active) return { label: "已过期", cls: "bg-muted text-muted-foreground" };
  return { label: "生效中", cls: "bg-success/10 text-success" };
}

const COLUMNS: AdminColumn[] = [
  { label: "名称", className: "" },
  { label: "尾号", className: "font-mono" },
  { label: "创建时间", className: "whitespace-nowrap hidden md:table-cell" },
  { label: "过期时间", className: "whitespace-nowrap hidden md:table-cell" },
  { label: "最后使用", className: "whitespace-nowrap hidden lg:table-cell" },
  { label: "状态", className: "" },
  { label: "操作", className: "" },
];

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

  const sp = await searchParams;
  const tokens = await listAdminApiTokens(admin.userId);
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
          <code className="block rounded bg-background px-3 py-2 font-mono text-sm break-all select-all">
            {freshPlain}
          </code>
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
          <form action={createApiTokenAction} className="flex flex-wrap items-end gap-3 text-sm">
            <label className="space-y-1">
              <span className="block text-muted-foreground">名称（便于辨识用途）</span>
              <input
                name="name"
                required
                maxLength={64}
                placeholder="如：CI 脚本 / 本地 MCP"
                className="w-64 rounded-lg border bg-background px-3 py-1.5"
              />
            </label>
            <label className="space-y-1">
              <span className="block text-muted-foreground">有效期</span>
              <select
                name="days"
                defaultValue={String(ADMIN_API_TOKEN_DEFAULT_DAYS)}
                className="rounded-lg border bg-background px-2.5 py-1.5"
              >
                {ADMIN_API_TOKEN_DAYS.map((d) => (
                  <option key={d} value={d}>
                    {d} 天
                  </option>
                ))}
              </select>
            </label>
            <SubmitButton pendingText="签发中…">签发</SubmitButton>
          </form>
          <p className="mt-2 text-xs text-muted-foreground">
            每管理员最多 {ADMIN_API_TOKEN_LIMIT} 个有效 Token。Token 以{" "}
            <code className="font-mono">Authorization: Bearer</code> 调用{" "}
            <code className="font-mono">/api/manage/**</code>
            （契约见 docs/MANAGE-API.md）；持有人被撤下管理员 / 全站封禁 / 申请注销时全部 Token
            同步吊销。
          </p>
        </CardContent>
      </Card>

      <AdminDataTable
        columns={COLUMNS}
        hasRows={tokens.length > 0}
        emptyText="还没有签发过 Token。"
        rows={tokens.map((t) => {
          const badge = statusBadgeOf(t);
          const cells: AdminCell[] = [
            {
              cls: "",
              node: (
                <div className="max-w-56 truncate" title={t.name}>
                  {t.name}
                </div>
              ),
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
            {
              cls: "",
              node: (
                <span className={`rounded px-1.5 py-0.5 text-xs ${badge.cls}`}>{badge.label}</span>
              ),
            },
            {
              cls: "",
              node:
                t.revokedAt === null && t.active ? (
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
