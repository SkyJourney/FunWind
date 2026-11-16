import { buildAdminQuery } from "@/lib/admin/query";
import { fmtDateTime } from "@/lib/admin/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { Pagination } from "@/components/content/pagination";
import { revokeUserSessionAction } from "../actions";

/**
 * 用户详情「活动与审计」签（M19 S1-5；从 page.tsx 迁出以控行数）：
 * 会话（可吊销）+ 积分台账（分页）+ 徽章 + 最近治理审计。
 */
export function UserActivityTab({
  detail,
  ledger,
  badges,
  pointsName,
  canViewIp,
}: {
  detail: {
    id: number;
    sessions: {
      id: string;
      createdAt: string;
      lastSeenAt: string | null;
      expiresAt: string;
      active: boolean;
      ip: string | null;
    }[];
    audit: { id: number; createdAt: string; action: string; actorId: number | null }[];
  };
  ledger: {
    items: { id: number; createdAt: string; channel: string; delta: number; note: string }[];
    page: number;
    totalPages: number;
  };
  badges: { name: string }[];
  pointsName: string;
  canViewIp: boolean;
}) {
  const tab = "activity" as const;
  return (
    <>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
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
                      <input type="hidden" name="tab" value={tab} />
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
              basePath={buildAdminQuery(`/admin/users/${detail.id}`, { tab: "activity" })}
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
    </>
  );
}
