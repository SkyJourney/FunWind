"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import { useMotionLifecycle } from "@/lib/motion";
import { MotionLink, useMotionRouter } from "./motion-navigation";

/** flag 由 E2E addInitScript 在加载前置入、页面生命周期内不变，无需订阅；服务端快照恒 false（SSR 安全）。 */
const noopSubscribe = () => () => {};
const readTestFlag = () =>
  Boolean((window as unknown as { __fwMotionTest?: boolean }).__fwMotionTest);

/**
 * 测试专用持久导航 harness（M15 Step 4 脱离 motion-lab）：挂在根 layout、provider 内、页面边界外，
 * 故 useMotionLifecycle 落全局作用域，跨页导航持续记录生命周期。仅当 E2E 经 addInitScript 置
 * window.__fwMotionTest 时渲染并注册钩子；生产无 flag 时渲染 null、不注册——不是 lab 实验资产。
 * 用真实 MotionLink / useMotionRouter 验证兄弟页与跨根导航，契约与旧实验面板一致供 pilot 用例复用。
 */
export function MotionTestHarness() {
  const active = useSyncExternalStore(noopSubscribe, readTestFlag, () => false);
  const [href, setHref] = useState("/a");
  const router = useMotionRouter();
  const output = useRef<HTMLOutputElement>(null);
  const events = useRef<{ phase: string; id: number; reason?: string }[]>([]);
  const record = (phase: string, id: number, reason?: string) => {
    if (!output.current) return;
    events.current = [...events.current, { phase, id, ...(reason ? { reason } : {}) }].slice(-50);
    output.current.dataset.events = JSON.stringify(events.current);
  };
  useMotionLifecycle(
    active
      ? {
          onIntent: (ctx) => record("intent", ctx.id),
          onBeforeTransition: (ctx) => record("before", ctx.id),
          onReady: (ctx) => record("ready", ctx.id),
          onFinish: (ctx) => record("finish", ctx.id),
          onSkip: (ctx, reason) => record("skip", ctx.id, reason),
        }
      : {},
  );
  if (!active) return null;
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
    </aside>
  );
}
