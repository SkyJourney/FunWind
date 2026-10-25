"use client";

import { useEffect } from "react";

/**
 * 主题页的浏览量信标（M6.5b）：挂载后发送一次 `POST /api/views`。
 * 不渲染任何内容；失败静默（浏览量是估计值）。同一访客的去重由服务端完成，React 严格模式的重复挂载无害。
 */
export function ViewBeacon({ tid }: { tid: number }) {
  useEffect(() => {
    void fetch("/api/views", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tid }),
      credentials: "same-origin",
      keepalive: true,
    }).catch(() => {});
  }, [tid]);
  return null;
}
