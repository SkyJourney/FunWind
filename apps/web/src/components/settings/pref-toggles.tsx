"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";

/**
 * 通知偏好开关（M10.6d 站长反馈 → M10.7 Step 5d 改为真正的 Switch）：一格一个控件——点击在开/关间切换，
 * 本地乐观更新 + toast，PATCH API 落库；失败回滚并报错。轨道 + 滑块，滑块带 spring 弹跳（ui/switch）。
 * 无障碍：role="switch" + aria-checked，名称取自 `label`（场景 + 渠道，如「新回复 · 站内」）。
 */
export function PrefToggleButton({
  type,
  channel,
  initialEnabled,
  onLabel,
  offLabel,
  label,
}: {
  type: string;
  channel: "in_app" | "email";
  initialEnabled: boolean;
  onLabel: string;
  offLabel: string;
  /** 开关的可访问名称 */
  label: string;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [pending, startTransition] = useTransition();

  const toggle = () => {
    const next = !enabled;
    setEnabled(next); // 乐观更新
    startTransition(async () => {
      try {
        const res = await fetch("/api/settings/preferences", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "notif", type, channel, enabled: next }),
        });
        if (!res.ok) throw new Error(String(res.status));
        toast.success(next ? onLabel : offLabel);
      } catch {
        setEnabled(!next); // 失败回滚
        toast.error("保存失败，请重试");
      }
    });
  };

  return (
    <div className="flex justify-center">
      <Switch checked={enabled} onCheckedChange={toggle} disabled={pending} aria-label={label} />
    </div>
  );
}

/** 私信三态切换（同款无跳转交互）：点击目标态即生效，toast 确认。 */
export function PmPolicyToggle({
  initialPolicy,
  labels,
}: {
  initialPolicy: "all" | "following" | "off";
  labels: Record<"all" | "following" | "off", string>;
}) {
  const [policy, setPolicy] = useState(initialPolicy);
  const [pending, startTransition] = useTransition();

  const apply = (next: "all" | "following" | "off") => {
    if (next === policy) return;
    const prev = policy;
    setPolicy(next);
    startTransition(async () => {
      try {
        const res = await fetch("/api/settings/preferences", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "pmPolicy", pmPolicy: next }),
        });
        if (!res.ok) throw new Error(String(res.status));
        toast.success(`私信权限已更新为「${labels[next]}」`);
      } catch {
        setPolicy(prev);
        toast.error("保存失败，请重试");
      }
    });
  };

  return (
    <div className="flex gap-1.5">
      {(["all", "following", "off"] as const).map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => apply(p)}
          disabled={pending}
          aria-pressed={policy === p}
          className={`rounded-full border px-3 py-1 text-xs transition-colors disabled:opacity-60 ${
            policy === p
              ? "border-primary bg-primary font-medium text-primary-foreground"
              : "text-muted-foreground hover:bg-accent"
          }`}
        >
          {labels[p]}
        </button>
      ))}
    </div>
  );
}
