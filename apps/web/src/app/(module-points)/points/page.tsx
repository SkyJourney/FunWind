import Link from "next/link";
import { redirect } from "next/navigation";
import { Pagination } from "@/components/content/pagination";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getPointsName } from "@/lib/auth/settings";
import { getCurrentUser } from "@/lib/auth/session";
import { channelLabel } from "@/lib/points/labels";
import { getLedgerPage } from "@/lib/points/ledger";
import { getPointRewardConfig, getPunchRewardConfig } from "@/lib/points/reward-load";

export const dynamic = "force-dynamic";
export const metadata = { title: "我的积分" };

const cap = (n: number) => (n === 0 ? "不限" : `每日 ≤ ${n}`);

/** 积分规则卡（M10.6d，S2 points 线稿定稿项）：当前生效的奖励值（后台可改，实时回表）。 */
async function PointsRulesCard() {
  const [pointsName, reward, punch] = await Promise.all([
    getPointsName(),
    getPointRewardConfig(),
    getPunchRewardConfig(),
  ]);
  const items = [
    { label: "发帖", value: `+${reward.post}（${cap(reward.postDailyCap)}）` },
    { label: "回帖", value: `+${reward.reply}（${cap(reward.replyDailyCap)}）` },
    { label: "每日签到", value: `随机 ${punch.min}–${punch.max}` },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{pointsName}规则</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2 text-sm">
        {items.map((it) => (
          <span key={it.label} className="rounded-full bg-muted px-3 py-1 text-muted-foreground">
            <span className="font-medium text-foreground">{it.label}</span> {it.value}
          </span>
        ))}
      </CardContent>
    </Card>
  );
}

export default async function PointsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const rawPage = Math.max(1, Number((await searchParams).page ?? "1") || 1);
  const [ledger, pointsName] = await Promise.all([
    getLedgerPage(user.id, rawPage),
    getPointsName(),
  ]);

  return (
    <main className="mx-auto max-w-3xl space-y-4 px-4 py-8 sm:px-6 lg:px-8">
      <Card>
        <CardHeader>
          <CardTitle>我的{pointsName}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
          <span>
            当前余额 <strong className="text-base text-foreground">{ledger.balance}</strong>
          </span>
          <span>累计获得 {ledger.lifetimeEarned}</span>
          <span>累计支出 {ledger.lifetimeSpent}</span>
          <span>共 {ledger.total} 条记录</span>
        </CardContent>
      </Card>

      <PointsRulesCard />

      <Card>
        <CardContent className="pt-6">
          {ledger.items.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              还没有{pointsName}记录。发帖、回帖、签到都能获得{pointsName}。
            </p>
          ) : (
            <ul className="divide-y">
              {ledger.items.map((it) => (
                <li key={it.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium">{channelLabel(it.channel)}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {it.createdAt}
                      {it.note ? ` · ${it.note}` : ""}
                    </p>
                  </div>
                  <div className="text-right tabular-nums">
                    <p
                      className={
                        it.delta > 0 ? "font-medium text-success" : "font-medium text-destructive"
                      }
                    >
                      {it.delta > 0 ? `+${it.delta}` : it.delta}
                    </p>
                    <p className="text-xs text-muted-foreground">余额 {it.balanceAfter}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Pagination basePath="/points" page={ledger.page} totalPages={ledger.totalPages} />

      <div className="text-center text-sm">
        <Link href={`/u/${user.id}`} className="text-muted-foreground hover:text-primary">
          ← 返回我的资料页
        </Link>
      </div>
    </main>
  );
}
