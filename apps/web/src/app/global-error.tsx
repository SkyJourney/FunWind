"use client";

import { useId } from "react";

/**
 * 根布局级兜底（root layout 自身抛错时唯一能渲染的边界）：
 * 不依赖任何布局/令牌加载顺序，自带 html/body，极简可恢复。
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const fallbackId = useId();
  const id = error.digest ?? `client-${fallbackId}`;
  return (
    <html lang="zh-CN">
      <body
        style={{
          fontFamily: "system-ui, 'PingFang SC', 'Microsoft YaHei', sans-serif",
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          background: "#f8fafc",
          color: "#0f172a",
        }}
      >
        <div style={{ maxWidth: 420, textAlign: "center", padding: 24 }}>
          <h1 style={{ fontSize: 20, marginBottom: 8 }}>站点暂时不可用</h1>
          <p style={{ fontSize: 14, color: "#64748b", marginBottom: 16 }}>
            错误已记录（ID: {id}），请刷新重试。
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              padding: "8px 20px",
              borderRadius: 10,
              border: "1px solid #cbd5e1",
              background: "#fff",
              cursor: "pointer",
            }}
          >
            刷新
          </button>
        </div>
      </body>
    </html>
  );
}
