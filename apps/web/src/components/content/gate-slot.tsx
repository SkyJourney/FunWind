import { Lock } from "lucide-react";

/**
 * 门控占位卡片（S4-3 过渡实现）：正文里有门控的位置只显示一张中性卡片。
 * 它**不读取** post_gates，因此不可能泄露任何隐藏内容、条件或价格；
 * S4-4 用真正的 GateBlock（按登录/解锁/作者/版主状态渲染）替换它。
 */
export function GateSlot({ gateKey }: { gateKey: string }) {
  return (
    <div
      className="my-3 flex items-center gap-2 rounded-lg border border-dashed bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
      data-gate-key={gateKey}
    >
      <Lock className="size-4 shrink-0" />
      此处有隐藏内容
    </div>
  );
}
