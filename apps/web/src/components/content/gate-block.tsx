import Link from "next/link";
import { BadgeCheck, Lock, ShieldCheck, Sparkles, Store } from "lucide-react";
import { unlockGateAction } from "@/app/actions/gates";
import { RichContent } from "@/components/content/rich-content";
import type { GatePrompt, GateView } from "@/lib/gates/types";

/**
 * 门控块（服务端组件，docs/GATES.md §4）。五种状态：
 *   未登录 / 未满足 / 已满足（已购买·已解锁·已回复）/ 作者 / 版主·admin。
 * 隐藏正文只会出现在 open 的 view 里，并且走与公开正文同一套净化管线；locked 的 view 里根本没有正文。
 * 付费条件的购买按钮提交 Server Action（unlockGateAction → unlockGate）；余额不足时按钮禁用。
 */

const lockedCard = "my-3 space-y-2 rounded-lg border border-dashed bg-muted/40 px-4 py-3 text-sm";

function PromptLine({
  prompt,
  pointsName,
  gateId,
  returnPage,
}: {
  prompt: GatePrompt;
  pointsName: string;
  gateId: number;
  returnPage: number;
}) {
  switch (prompt.kind) {
    case "login":
      return (
        <p>
          <Link href="/login" className="text-primary hover:underline">
            登录
          </Link>
          后查看此处的隐藏内容
        </p>
      );
    case "points":
      return (
        <div className="space-y-1.5">
          <p className="font-medium">
            {prompt.price === 0
              ? "免费解锁内容（需点击解锁）"
              : `付费内容 · ${prompt.price} ${pointsName}`}
          </p>
          <p className="text-xs text-muted-foreground">
            当前余额 {prompt.balance} {pointsName}
            {prompt.balance < prompt.price && "（余额不足）"}
          </p>
          {/* 购买走 Server Action：成功后整页重渲染（不提供任何返回隐藏内容的 JSON 接口） */}
          <form action={unlockGateAction}>
            <input type="hidden" name="gateId" value={gateId} />
            <input type="hidden" name="page" value={returnPage} />
            {/* 买家看到的价格随表单提交，服务端按它核对，避免作者在点击前改价而被按新价扣款 */}
            <input type="hidden" name="expectedPrice" value={prompt.price} />
            <button
              type="submit"
              disabled={prompt.balance < prompt.price}
              className="rounded-md border border-primary/40 bg-primary/10 px-3 py-1 text-xs font-medium text-primary hover:bg-primary/20 disabled:cursor-not-allowed disabled:border-border disabled:bg-transparent disabled:text-muted-foreground"
            >
              {prompt.price === 0 ? "免费解锁" : `${prompt.price} ${pointsName} 解锁`}
            </button>
          </form>
        </div>
      );
    case "reply":
      return <p className="font-medium">回复本帖后可见</p>;
    case "unavailable":
      return <p className="text-muted-foreground">该内容暂不可用</p>;
  }
}

function openLabel(view: Extract<GateView, { status: "open" }>, pointsName: string) {
  switch (view.reason) {
    case "author":
      return {
        icon: <Store className="size-3.5" />,
        text:
          view.stats !== undefined
            ? `你的付费内容 · ${view.stats.buyers} 人解锁 · 收益 ${view.stats.income} ${pointsName}`
            : "你的隐藏内容",
      };
    case "moderator":
      return { icon: <ShieldCheck className="size-3.5" />, text: "管理员可见" };
    case "unlocked":
      return {
        icon: <BadgeCheck className="size-3.5" />,
        text:
          view.pricePaid && view.pricePaid > 0
            ? `已购买 · ${view.pricePaid} ${pointsName}${view.unlockedAt ? ` · ${view.unlockedAt}` : ""}`
            : `已解锁${view.unlockedAt ? ` · ${view.unlockedAt}` : ""}`,
      };
    case "replied":
      return { icon: <Sparkles className="size-3.5" />, text: "已回复，内容已解锁" };
  }
}

export function GateBlock({
  view,
  pointsName,
  returnPage = 1,
}: {
  /** undefined = 正文里有占位但 post_gates 没有对应行（数据不一致）：失败即封闭，不显示任何内容 */
  view: GateView | undefined;
  pointsName: string;
  /** 购买后回到的页码（首帖在每一页都显示，需要知道用户当前在第几页） */
  returnPage?: number;
}) {
  if (!view) {
    return (
      <div className={`${lockedCard} text-muted-foreground`}>
        <Lock className="mr-1 inline size-4" />
        门控数据异常，内容暂不可显示
      </div>
    );
  }

  if (view.status === "locked") {
    return (
      <div className={lockedCard} data-gate-state="locked">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Lock className="size-4 shrink-0" />
          <span>隐藏内容</span>
        </div>
        {view.prompts.map((p) => (
          <PromptLine
            key={p.kind}
            prompt={p}
            pointsName={pointsName}
            gateId={view.gateId}
            returnPage={returnPage}
          />
        ))}
      </div>
    );
  }

  const label = openLabel(view, pointsName);
  return (
    <div className="my-3 rounded-lg border bg-card" data-gate-state="open">
      <div className="flex items-center gap-1.5 border-b bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground">
        {label.icon}
        {label.text}
      </div>
      <div className="px-4 py-3">
        <RichContent md={view.contentMd} />
      </div>
    </div>
  );
}
