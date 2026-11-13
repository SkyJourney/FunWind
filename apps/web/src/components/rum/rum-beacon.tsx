"use client";

import { useEffect } from "react";
// 只 import 零依赖的 protocol：schema.ts 带 zod，根布局组件引用它会把 zod 拖进每个页面的 bundle
import { RUM_MAX_SAMPLES, type RumSample } from "@/lib/rum/protocol";

/**
 * 真实用户监测采集（M17 Step 4）。零新依赖：原生 PerformanceObserver + 错误监听 + keepalive fetch。
 *
 * **不拖慢首屏的三条**（LCP 不回退是硬门禁）：
 *  1. `return null`——零 DOM、零布局、零样式；
 *  2. 观察者用 `buffered: true`，历史 entry 不会丢，所以注册时机可以晚于首屏绘制；
 *     这里再套一层 idle 调度，连「注册」本身都不与首屏争抢主线程；
 *  3. **首屏期间绝不发请求**：只在 pagehide / 页面转隐藏 / 60s 定时器到点时上报，
 *     且没有新样本就不发。错误监听回调只入队，不做任何重活。
 *
 * 隐私：只传 `location.pathname`（**不含查询串与片段**——一次性令牌都在查询串里，
 * 不让它们离开浏览器）；错误只取 message，**不取堆栈、不取参数**。服务端还会再脱敏一次。
 *
 * 仅生产构建采集（照 ServiceWorkerRegistration）：dev 不采集；E2E 的生产构建会采集，
 * 但落的是隔离 E2E 库，不污染生产观测数据。
 */

/** 指标值没变化就不重复上报（同一会话多次 flush 不产生重复样本） */
const FLUSH_INTERVAL_MS = 60_000;
/** 错误队列上限：防止错误风暴把内存和请求体撑爆 */
const ERROR_QUEUE_MAX = 20;

type VitalName = "LCP" | "CLS" | "INP";

export function RumBeacon() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof PerformanceObserver === "undefined") return;

    const latest = new Map<VitalName, number>();
    const sent = new Map<VitalName, number>();
    const errors: RumSample[] = [];
    const observers: PerformanceObserver[] = [];
    let stopped = false;

    const route = () => window.location.pathname;

    const pushError = (name: "js-error" | "unhandled-rejection", detail: string) => {
      if (errors.length >= ERROR_QUEUE_MAX) return;
      errors.push({ kind: "error", name, value: 0, route: route(), detail });
    };

    const onError = (e: ErrorEvent) => pushError("js-error", String(e.message ?? ""));
    const onRejection = (e: PromiseRejectionEvent) => {
      const reason = e.reason as { message?: unknown } | string | undefined;
      const msg = typeof reason === "string" ? reason : String(reason?.message ?? "");
      pushError("unhandled-rejection", msg);
    };

    const flush = () => {
      if (stopped) return;
      const samples: RumSample[] = [];
      for (const [name, value] of latest) {
        if (sent.get(name) === value) continue;
        samples.push({ kind: "vital", name, value, route: route() });
        sent.set(name, value);
      }
      // 错误样本一次性取走（队列清空），与指标一起去重后不重发
      samples.push(...errors.splice(0, ERROR_QUEUE_MAX));
      if (samples.length === 0) return;
      void fetch("/api/rum", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ v: 1, samples: samples.slice(0, RUM_MAX_SAMPLES) }),
        credentials: "same-origin",
        keepalive: true,
      }).catch(() => {
        // 观测数据丢一批可以接受，绝不重试、绝不抛
      });
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };

    /** 注册观察者：buffered 拿历史 entry，所以晚注册不丢数据 */
    const observe = () => {
      if (stopped) return;
      const track = (type: string, handle: (entry: PerformanceEntry) => void, extra?: object) => {
        try {
          const po = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) handle(entry);
          });
          po.observe({ type, buffered: true, ...extra } as PerformanceObserverInit);
          observers.push(po);
        } catch {
          // 该浏览器不支持这个 entryType：跳过该指标，不影响其它采集
        }
      };

      // LCP：取最后一条（会随更大元素出现而更新）
      track("largest-contentful-paint", (e) => latest.set("LCP", Math.round(e.startTime)));

      // CLS：累计非近期输入引起的位移；×1000 取整避免浮点列
      let cls = 0;
      track("layout-shift", (e) => {
        const shift = e as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
        if (shift.hadRecentInput) return;
        cls += shift.value ?? 0;
        latest.set("CLS", Math.round(cls * 1000));
      });

      // INP（近似）：按 interactionId 分组取各组最大 duration，再取全局最大。
      // 真正的 INP 是交互耗时的 p98；这里用最大值近似，宁可高估也不低估体验问题。
      const byInteraction = new Map<number, number>();
      track(
        "event",
        (e) => {
          const ev = e as PerformanceEntry & { interactionId?: number };
          const id = ev.interactionId ?? 0;
          if (id === 0) return; // 非交互事件不计入
          const prev = byInteraction.get(id) ?? 0;
          if (ev.duration > prev) byInteraction.set(id, ev.duration);
          let max = 0;
          for (const d of byInteraction.values()) if (d > max) max = d;
          latest.set("INP", Math.round(max));
        },
        { durationThreshold: 40 },
      );
    };

    // idle 时再注册，连注册开销都避开首屏；无 requestIdleCallback 时退化为下一轮任务
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void) => number })
      .requestIdleCallback;
    const idleHandle: number = ric ? ric(observe) : window.setTimeout(observe, 0);

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    const timer = setInterval(flush, FLUSH_INTERVAL_MS);

    return () => {
      stopped = true;
      for (const po of observers) po.disconnect();
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(timer);
      const cic = (window as unknown as { cancelIdleCallback?: (h: number) => void })
        .cancelIdleCallback;
      if (cic) cic(idleHandle);
      else clearTimeout(idleHandle);
    };
  }, []);

  return null;
}
