import Link from "next/link";
import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { ActionGroup } from "@/components/ui/action-group";
import { SubmitButton } from "@/components/ui/submit-button";
import type { CampaignListItem } from "@/lib/campaigns/list";
import type { CampaignStatus } from "@/lib/campaigns/status";
import { deleteCampaignAction, toggleCampaignAction } from "./actions";

const STATUS: Record<CampaignStatus, { label: string; cls: string }> = {
  active: { label: "生效中", cls: "bg-success/10 text-success" },
  upcoming: { label: "未开始", cls: "bg-warning/10 text-warning" },
  ended: { label: "已结束", cls: "bg-muted text-muted-foreground" },
  disabled: { label: "已停用", cls: "bg-muted text-muted-foreground" },
};

const BTN = "shrink-0 rounded-md border px-2.5 py-1 text-xs whitespace-nowrap hover:bg-accent";

/** 分钟精度展示，不经本地时区解析（库内就是北京墙面时间） */
const minute = (value: string) => value.slice(0, 16);

/**
 * 一个 effect 分区：分区内按优先级从高到低。内容区可收缩（min-w-0 + 任意断行），
 * 操作区独立换行，按钮自身单行不收缩（自适应交互契约）。
 * 行为类分区（M11.4）带「行为类」徽标与后果提示——真实注册的账号与积分不会随方案结束回滚。
 */
export function CampaignSection({
  title,
  items,
  labelOf,
  behavior,
}: {
  title: string;
  items: CampaignListItem[];
  labelOf: (item: CampaignListItem) => string;
  behavior?: boolean;
}) {
  return (
    <section className="space-y-2">
      <h3 className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-semibold">
        <span className="min-w-0">{title}</span>
        {behavior && (
          <>
            <span className="shrink-0 rounded bg-warning/10 px-1.5 py-0.5 text-[11px] font-normal text-warning">
              行为类
            </span>
            <span className="min-w-0 text-xs font-normal text-muted-foreground">
              会产生无法撤回的后果：真实注册的账号与积分不随方案结束回滚
            </span>
          </>
        )}
      </h3>
      <ul className="grid gap-2">
        {items.map((item) => (
          <CampaignRow key={item.id} item={item} summary={labelOf(item)} />
        ))}
      </ul>
    </section>
  );
}

function CampaignRow({ item, summary }: { item: CampaignListItem; summary: string }) {
  const status = STATUS[item.status];
  return (
    <li
      data-testid="campaign-row"
      className="grid min-w-0 gap-2 rounded-xl border bg-card p-3 text-sm"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{item.name}</span>
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${status.cls}`}>
          {status.label}
        </span>
        {item.invalid && (
          <span className="shrink-0 rounded bg-destructive/10 px-1.5 py-0.5 text-[11px] text-destructive">
            配置无效
          </span>
        )}
      </div>
      <Details item={item} summary={summary} />
      <Actions item={item} />
    </li>
  );
}

function Details({ item, summary }: { item: CampaignListItem; summary: string }) {
  return (
    <div className="grid min-w-0 gap-0.5 text-xs text-muted-foreground">
      <p className="[overflow-wrap:anywhere]">{summary}</p>
      <p>
        {minute(item.startsAt)} ~ {item.endsAt ? minute(item.endsAt) : "长期"} · 优先级{" "}
        {item.priority} · v{item.revision}
      </p>
      {item.overriddenBy !== null && (
        <p className="text-warning">重叠时段被方案 #{item.overriddenBy}（优先级更高）覆盖</p>
      )}
    </div>
  );
}

function Actions({ item }: { item: CampaignListItem }) {
  return (
    <ActionGroup className="gap-y-1.5">
      <Link href={`/admin/campaigns?edit=${item.id}`} className={BTN}>
        编辑
      </Link>
      <form action={toggleCampaignAction}>
        <input type="hidden" name="id" value={item.id} />
        <input type="hidden" name="enabled" value={item.enabled ? "0" : "1"} />
        <SubmitButton className={BTN}>{item.enabled ? "停用" : "启用"}</SubmitButton>
      </form>
      <form action={deleteCampaignAction}>
        <input type="hidden" name="id" value={item.id} />
        <ConfirmSubmit
          title="删除这个排期方案？"
          description="删除后该方案立即停止生效，站点回到常态配置；此操作不可撤销（审计记录保留）。"
          className={`${BTN} text-destructive hover:bg-destructive/10`}
          pendingText="删除中…"
        >
          删除
        </ConfirmSubmit>
      </form>
    </ActionGroup>
  );
}
