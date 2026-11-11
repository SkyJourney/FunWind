"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useSiteMotion } from "./motion-provider";

/** 历史恢复不伪装主动push；Navigation API可用时在URL改变前保留真实来源，popstate负责登记跳过。 */
export function NavKindCapture() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const key = `${pathname}${search ? `?${search}` : ""}`;
  const motion = useSiteMotion();
  const currentPath = useRef(key);
  const traversal = useRef<{ from: string; to: string } | null>(null);
  useEffect(() => {
    currentPath.current = key;
  }, [key]);
  useEffect(() => {
    const navigation = (window as unknown as { navigation?: EventTarget }).navigation;
    const currentKey = () => `${window.location.pathname}${window.location.search}`;
    const onNavigate = (raw: Event) => {
      const event = raw as Event & { navigationType?: string; destination?: { url: string } };
      const target = event.destination
        ? new URL(event.destination.url, window.location.href)
        : null;
      const to = target ? `${target.pathname}${target.search}` : null;
      if (event.navigationType === "traverse" && to !== null) {
        traversal.current = { from: currentKey(), to };
      } else if (!(
        event.navigationType === "replace" &&
        traversal.current?.to === to &&
        currentKey() === to
      )) {
        // Next恢复history时会同URL replace写状态；它不能擦掉尚未消费的traverse来源。
        traversal.current = null;
      }
    };
    const onPop = () => {
      const to = currentKey();
      // Next可在本监听前同步刷新React路由上下文，不能把已更新的ref当作历史来源。
      const from = traversal.current?.to === to ? traversal.current.from : currentPath.current;
      traversal.current = null;
      motion.pop(from, to);
    };
    navigation?.addEventListener("navigate", onNavigate, true);
    window.addEventListener("popstate", onPop, true);
    return () => {
      navigation?.removeEventListener("navigate", onNavigate, true);
      window.removeEventListener("popstate", onPop, true);
    };
  }, [motion]);
  return null;
}
