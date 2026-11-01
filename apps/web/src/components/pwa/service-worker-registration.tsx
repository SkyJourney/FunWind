"use client";

import { useEffect } from "react";

/** 生产环境注册同源 Service Worker；开发服务器不注册，避免 HMR 与缓存相互污染。 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      // SW 注册失败不影响站点正常在线使用；PWA E2E 会单独校验生产注册结果。
    });
  }, []);

  return null;
}
