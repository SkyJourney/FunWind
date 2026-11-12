"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { toast } from "sonner";

/**
 * 联网状态感知（M16.1 Step 3）：断网/恢复时给一条轻量提示，不推挤页面布局。
 *
 * 此前只有 offline.html 里一个手动「重新连接」按钮——用户在被 SW 接管的离线壳里，
 * 不知道什么时候网络回来了，也没有任何提示。这里在应用层补上：
 * - 断网：常驻提示（duration Infinity，可手动关闭），说明新内容暂时加载不了；
 * - 恢复：撤掉断网提示并确认一次。**首次进站在线时不提示**，不能平白喊「网络已恢复」。
 *
 * SSR 安全：useSyncExternalStore 的服务端快照恒为 true（服务端没有 navigator），
 * 与首帧一致不产生水合 mismatch；真实状态在客户端订阅后生效（与 reply-fab 的 canObserve 同款）。
 */
const TOAST_ID = "fw-connection";

const subscribe = (onChange: () => void) => {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
};
const readOnline = () => navigator.onLine;
const serverOnline = () => true;

export function ConnectionStatus() {
  const isOnline = useSyncExternalStore(subscribe, readOnline, serverOnline);
  const wasOffline = useRef(false);

  useEffect(() => {
    if (!isOnline) {
      wasOffline.current = true;
      toast.warning("网络已断开", {
        id: TOAST_ID,
        description: "暂时无法加载新内容，恢复后会自动提示。",
        duration: Infinity,
      });
      return;
    }
    toast.dismiss(TOAST_ID);
    if (wasOffline.current) {
      wasOffline.current = false;
      toast.success("网络已恢复", { description: "可以继续浏览最新内容。" });
    }
  }, [isOnline]);

  return null;
}
