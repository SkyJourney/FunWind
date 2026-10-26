import { notFound } from "next/navigation";
import { getCurrentSubject } from "@/lib/authz/subject";
import { getPollView, type PollView } from "@/lib/poll/service";
import { voteAction } from "@/app/actions/poll";
import { SubmitButton } from "@/components/ui/submit-button";
import { Card, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

/**
 * 投票块（M10）：kind=poll 的主题在首帖正文后渲染。
 * 四态：可投（未投未截止）/ 已投（显示所选+结果）/ 截止（结果+截止标记）/ 结果隐藏（after_vote 未投）。
 * 游客：显示选项但按钮为登录引导；结果按 resultVisibility 口径。
 */

const voteErrorText: Record<string, string> = {
  login: "请先登录后投票。",
  forbidden: "你没有参与投票的权限。",
  closed: "投票已截止。",
  option_limit: "超出了可选项数上限。",
  option_invalid: "选项无效，请重试。",
  not_found: "投票不存在。",
};

export default async function PollBlock({
  threadId,
  voteError,
}: {
  threadId: number;
  voteError?: string;
}) {
  const viewer = await getCurrentSubject();
  const view: PollView | null = await getPollView(viewer, threadId);
  if (!view) notFound();

  const showVoteForm = viewer.userId !== null && !view.closed;

  return (
    <Card id="poll" className="scroll-mt-20">
      <CardContent className="pt-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">投票</h2>
          <span className="text-xs text-muted-foreground">
            {view.closed
              ? "已截止"
              : view.endsAt
                ? `截止于 ${view.endsAt}`
                : `可多选 ${view.optionLimit} 项`}
          </span>
        </div>

        {voteError && voteErrorText[voteError] && (
          <p
            role="alert"
            className="mb-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning"
          >
            {voteErrorText[voteError]}
          </p>
        )}

        <form action={voteAction}>
          <input type="hidden" name="threadId" value={threadId} />
          <ul className="space-y-2">
            {view.options.map((o) => {
              const showBar = o.count !== null;
              return (
                <li key={o.id} className="relative rounded-lg border px-3 py-2 text-sm">
                  {showBar && o.percent !== null && o.percent > 0 && (
                    <div
                      aria-hidden
                      className="absolute inset-y-0 left-0 rounded-l-lg bg-primary/15"
                      style={{ width: `${o.percent}%` }}
                    />
                  )}
                  <div className="relative flex items-center justify-between gap-3">
                    <label className="flex min-w-0 items-center gap-2">
                      {showVoteForm && (
                        <input
                          type={view.optionLimit > 1 ? "checkbox" : "radio"}
                          name="optionIds"
                          value={o.id}
                          defaultChecked={o.voted}
                          className="size-4 shrink-0"
                        />
                      )}
                      {!showVoteForm && o.voted && <span className="text-primary">✓</span>}
                      <span className="truncate">{o.content}</span>
                    </label>
                    {showBar && (
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {o.count} 票 · {o.percent}%
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          {showVoteForm && (
            <div className="mt-3 flex items-center gap-3">
              <SubmitButton
                className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                pendingText="提交中…"
              >
                {view.myOptionIds.length > 0 ? "改票" : "投票"}
              </SubmitButton>
              {view.myOptionIds.length > 0 && (
                <span className="text-xs text-muted-foreground">
                  你已投 {view.myOptionIds.length} 项，可修改后重新提交
                </span>
              )}
              {view.optionLimit > 1 && (
                <span className="text-xs text-muted-foreground">最多选 {view.optionLimit} 项</span>
              )}
            </div>
          )}
        </form>

        {!viewer.userId && !view.closed && (
          <p className="mt-2 text-xs text-muted-foreground">登录后可参与投票。</p>
        )}
        {view.voterCount !== null && (
          <p className="mt-2 text-xs text-muted-foreground">
            共 {view.voterCount} 人投票 · {view.totalVotes ?? 0} 票
          </p>
        )}
        {view.voterCount === null && (
          <p className="mt-2 text-xs text-muted-foreground">投票后才能查看结果。</p>
        )}
      </CardContent>
    </Card>
  );
}
