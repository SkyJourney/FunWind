import { channelLabel } from "@/lib/points/labels";
import type { LedgerItem } from "@/lib/points/ledger";

/**
 * 积分流水行（/points）：服务端渲染的首屏与客户端追加项共用同一份版式。
 * 只读展示，不含任何积分写入路径（写路径一律在 lib/points）。
 */
export function LedgerRow({
  item,
  className,
  style,
}: {
  item: LedgerItem;
  /** 附加到根元素的类（首屏错落进场 / 追加项淡入） */
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <li
      className={`flex items-center justify-between gap-3 py-2.5 text-sm${className ? ` ${className}` : ""}`}
      style={style}
    >
      <div className="min-w-0">
        <p className="font-medium">{channelLabel(item.channel)}</p>
        <p className="truncate text-xs text-muted-foreground">
          {item.createdAt}
          {item.note ? ` · ${item.note}` : ""}
        </p>
      </div>
      <div className="text-right tabular-nums">
        <p className={item.delta > 0 ? "font-medium text-success" : "font-medium text-destructive"}>
          {item.delta > 0 ? `+${item.delta}` : item.delta}
        </p>
        <p className="text-xs text-muted-foreground">余额 {item.balanceAfter}</p>
      </div>
    </li>
  );
}
