"use client";

import { useEffect } from "react";
import { toast } from "sonner";

/**
 * 生产环境注册同源 Service Worker；开发服务器不注册，避免 HMR 与缓存相互污染。
 *
 * M16.1 Step 3：
 * - 注册 URL 带部署版本（`?v=<BUILD_ID>`，由 layout 服务端读入）——sw.js 是静态文件，
 *   不带版本的话部署后脚本字节不变，浏览器不会重装，离线壳会一直停在旧版本。
 * - **更新提示**：SW 是 skipWaiting + clients.claim 立即接管，新 SW 一上来就换控制者。
 *   此时页面里跑着的仍是旧版 JS，所以要提示用户刷新。首次安装也会触发 controllerchange，
 *   用「加载时是否已有 controller」把这种情况排除掉，不能对第一次进站的人喊「已更新」。
 */
export function ServiceWorkerRegistration({ version }: { version: string }) {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    // 捕获容器引用：清理时用当初注册的那个对象，不在卸载时重读全局
    const container = navigator.serviceWorker;
    let hadController = Boolean(container.controller);
    let notified = false;
    const onControllerChange = () => {
      if (!hadController) {
        hadController = true; // 首次安装接管：不是更新，不提示
        return;
      }
      if (notified) return; // 一次会话只提示一次，避免反复接管刷屏
      notified = true;
      toast.info("站点已更新", {
        id: "fw-sw-updated",
        description: "刷新后使用新版本。",
        duration: Infinity,
        action: { label: "刷新", onClick: () => window.location.reload() },
      });
    };
    container.addEventListener("controllerchange", onControllerChange);
    void container.register(`/sw.js?v=${encodeURIComponent(version)}`, { scope: "/" }).catch(() => {
      // SW 注册失败不影响站点正常在线使用；PWA E2E 会单独校验生产注册结果。
    });
    return () => container.removeEventListener("controllerchange", onControllerChange);
  }, [version]);

  return null;
}
