"use client";

import { useEffect, useRef, useState } from "react";
import { useMotionLifecycle } from "@/lib/motion";
import { MotionLink, useMotionRouter } from "./motion-navigation";

/** 仅从实验室显式开启的持久宿主，用真实 Link/router 验证兄弟页导航；随实验室在 Step4 删除。 */
export function MotionLabPanel() {
  const [open, setOpen] = useState(false);
  const [href, setHref] = useState("/a");
  const router = useMotionRouter();
  const output = useRef<HTMLOutputElement>(null);
  const events = useRef<{ phase: string; id: number; reason?: string }[]>([]);
  const record = (phase: string, id: number, reason?: string) => {
    if (!output.current) return;
    events.current = [...events.current, { phase, id, ...(reason ? { reason } : {}) }].slice(-50);
    output.current.dataset.events = JSON.stringify(events.current);
  };
  useMotionLifecycle({
    onIntent: (ctx) => record("intent", ctx.id),
    onBeforeTransition: (ctx) => record("before", ctx.id),
    onReady: (ctx) => record("ready", ctx.id),
    onFinish: (ctx) => record("finish", ctx.id),
    onSkip: (ctx, reason) => record("skip", ctx.id, reason),
  });
  useEffect(() => {
    const enable = () => setOpen(true);
    window.addEventListener("funwind:motion-lab", enable);
    return () => window.removeEventListener("funwind:motion-lab", enable);
  }, []);
  if (!open) return null;
  const safeHref = href.startsWith("/") && !href.startsWith("//") ? href : "/a";
  return (
    <aside
      aria-label="导航实验面板"
      className="fixed right-4 bottom-20 z-50 flex max-w-[calc(100vw-2rem)] flex-wrap items-center gap-2 rounded-lg border bg-background p-3 text-sm"
    >
      <label>
        站内目标地址
        <input
          className="ml-2 w-40 rounded border bg-background px-2 py-1"
          value={href}
          onChange={(event) => setHref(event.target.value)}
        />
      </label>
      <MotionLink href={safeHref} className="text-primary underline">
        链接前往
      </MotionLink>
      <button
        type="button"
        className="rounded border px-2 py-1"
        onClick={() => router.push(safeHref)}
      >
        程序化前往
      </button>
      <output ref={output} aria-label="动效生命周期" data-events="[]" className="sr-only" />
      <button
        type="button"
        className="rounded border px-2 py-1"
        onClick={() => {
          events.current = [];
          if (output.current) output.current.dataset.events = "[]";
        }}
      >
        清空动效记录
      </button>
      <button type="button" className="rounded border px-2 py-1" onClick={() => setOpen(false)}>
        关闭实验面板
      </button>
    </aside>
  );
}
