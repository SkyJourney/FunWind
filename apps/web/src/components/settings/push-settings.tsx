"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { patchPreference } from "@/lib/api/settings-pref";
import {
  getDeviceSubscription,
  isPushSupported,
  subscribeDevice,
  unsubscribeDevice,
} from "@/lib/push/client";

/**
 * 通知偏好页的推送列（M18 Step 4）：设备级订阅闸 + 逐类型开关。
 * 显式 opt-in——先订阅本设备（浏览器权限 + PushManager），再按场景开启；一步退订。
 * 能力探测 SSR 安全（水合前一律隐藏，水合后按能力呈现，无 hydration mismatch）；
 * 不支持的设备（含未装 PWA 的 iOS）整列优雅隐藏，不报错。
 */

/** 水合前 false、水合后按能力探测（无 setState-in-effect，照 theme-switcher useMounted 范式） */
function usePushSupported(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => isPushSupported(),
    () => false,
  );
}

interface PushState {
  supported: boolean;
  subscribed: boolean;
  busy: boolean;
  subscribe: () => Promise<boolean>;
  unsubscribe: () => Promise<boolean>;
}

const PushContext = createContext<PushState>({
  supported: false,
  subscribed: false,
  busy: false,
  subscribe: async () => false,
  unsubscribe: async () => false,
});

/** 设备订阅状态共享给设备卡片与逐类型开关；订阅/退订后全局同步 */
export function PushProvider({ children }: { children: ReactNode }) {
  const supported = usePushSupported();
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!supported) return;
    let alive = true;
    void getDeviceSubscription().then((sub) => {
      if (alive) setSubscribed(Boolean(sub));
    });
    return () => {
      alive = false;
    };
  }, [supported]);

  const subscribe = useCallback(async () => {
    setBusy(true);
    try {
      const res = await subscribeDevice();
      if (res.ok) {
        setSubscribed(true);
        toast.success("已开启本设备推送");
        return true;
      }
      const msg =
        res.reason === "denied"
          ? "浏览器拒绝了通知权限，请在浏览器设置中允许"
          : res.reason === "no-key"
            ? "站点推送尚未配置，请稍后再试"
            : res.reason === "unsupported"
              ? "此设备不支持推送"
              : "开启推送失败，请重试";
      toast.error(msg);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const unsubscribe = useCallback(async () => {
    setBusy(true);
    try {
      const ok = await unsubscribeDevice();
      if (ok) {
        setSubscribed(false);
        toast.success("已关闭本设备推送");
      } else {
        toast.error("关闭推送失败，请重试");
      }
      return ok;
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <PushContext.Provider value={{ supported, subscribed, busy, subscribe, unsubscribe }}>
      {children}
    </PushContext.Provider>
  );
}

function usePush(): PushState {
  return useContext(PushContext);
}

/** 设备级订阅闸：开启/关闭本设备推送（一步退订），呈现订阅状态 */
export function PushDeviceCard() {
  const { supported, subscribed, busy, subscribe, unsubscribe } = usePush();
  if (!supported) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-card px-4 py-3">
      <div className="min-w-0 flex-1 basis-40">
        <p className="text-sm font-medium">本设备推送</p>
        <p className="text-xs text-muted-foreground">
          {subscribed
            ? "已订阅：开启下方场景后，离开站点也能收到通知，点击通知直达对应页面。"
            : "开启后，有新回复 / 提及 / 私信时即使离开站点也能收到通知（需浏览器授权，可随时关闭）。"}
        </p>
      </div>
      {subscribed ? (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void unsubscribe()}>
          关闭推送
        </Button>
      ) : (
        <Button size="sm" disabled={busy} onClick={() => void subscribe()}>
          开启推送
        </Button>
      )}
    </div>
  );
}

/** 推送列表头（不支持时隐藏，与 PushCell 同步） */
export function PushHeaderCell() {
  const { supported } = usePush();
  if (!supported) return null;
  return <span className="w-28 text-center">推送</span>;
}

/** 逐类型推送开关：开启时若设备未订阅先订阅（成功才写偏好）；关闭仅关该场景，设备订阅保留。
 * available=false（非 D2 接线类型）显示「—」占位，避免呈现永远收不到的失准开关。 */
export function PushCell({
  type,
  initialEnabled,
  label,
  available = true,
}: {
  type: string;
  initialEnabled: boolean;
  label: string;
  available?: boolean;
}) {
  const { supported, subscribed, busy, subscribe } = usePush();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [pending, setPending] = useState(false);
  if (!supported) return null;
  if (!available) {
    return (
      <div className="w-28">
        <div
          className="flex justify-center text-xs text-muted-foreground"
          aria-label={`${label}（暂不支持推送）`}
        >
          —
        </div>
      </div>
    );
  }

  const toggle = async () => {
    const next = !enabled;
    if (next && !subscribed) {
      const ok = await subscribe();
      if (!ok) return; // 订阅失败不写偏好
    }
    setEnabled(next); // 乐观更新
    setPending(true);
    try {
      const res = await patchPreference({ kind: "notif", type, channel: "push", enabled: next });
      if (!res.ok) throw new Error(String(res.status));
      toast.success(next ? "推送通知已开启" : "推送通知已关闭");
    } catch {
      setEnabled(!next); // 失败回滚
      toast.error("保存失败，请重试");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="w-28">
      <div className="flex justify-center">
        <Switch
          checked={enabled}
          onCheckedChange={() => void toggle()}
          disabled={pending || busy}
          aria-label={label}
        />
      </div>
    </div>
  );
}
