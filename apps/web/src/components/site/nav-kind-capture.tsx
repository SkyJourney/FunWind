"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useSiteMotion } from "./motion-provider";
import {
  backfillScrollRecord,
  flushScrollRecord,
  getScrollRecord,
  lockScroll,
  pinScrollAtCurrent,
  recordScroll,
  scrollLockAlive,
} from "./scroll-record";

/**
 * 恢复窗口：流式页面（RSC 分次 commit）的 Next 滚顶会晚到多次，窗口须覆盖整个流式周期。
 * 上限 6s：Step 4.5 CI 实测 2 核慢机上滚顶可晚到 4s 之后（原 4s 窗口耗尽后污染无人对抗）——
 * 真实竞态而非环境假象（本机高负载 4 连跑复现 1 次）。配合「连续稳定 1.5s 提前收尾」，
 * 正常路径实际结束更早，只有真在滚顶风暴里才用满窗口。
 */
const RESTORE_ATTEMPTS = 60;
const RESTORE_DELAY_MS = 100;
/** 连续稳定判定：滚动位置连续这么多次都在目标附近（1.5s），视为恢复完成、提前收尾 */
const RESTORE_STABLE_TICKS = 15;

/** 当前在跑的恢复循环停止函数（模块级：NavKindCapture 为全局单例） */
let activeRestoreStop: (() => void) | null = null;

/** 取消在跑的恢复循环（换页 / 卸载统一调用）：恢复循环绝不跨页强滚（Step 4.5 P1-2） */
function cancelRestoreLoop(): void {
  activeRestoreStop?.();
  activeRestoreStop = null;
}

/**
 * 滚动恢复循环：每 100ms 校正一次，直到「连续稳定 1.5s」或 6s 上限；用户真实输入
 * （滚轮 / 触摸 / 滚动键）立即让位，尊重用户新意图。
 * 停止函数登记到 activeRestoreStop：换页（key 变化）/ 卸载统一取消（cancelRestoreLoop）。
 */
function runRestoreLoop(page: string, saved: number): void {
  cancelRestoreLoop();
  let timer: ReturnType<typeof setInterval> | undefined;
  const cancel = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    window.removeEventListener("wheel", cancel);
    window.removeEventListener("touchstart", cancel);
    // 移除必须带与注册一致的捕获标志，否则监听永远泄漏
    window.removeEventListener("keydown", cancelKeys, true);
    if (activeRestoreStop === cancel) activeRestoreStop = null;
  };
  const cancelKeys = (raw: Event) => {
    const e = raw as KeyboardEvent;
    // 输入法组合中的按键（选字/翻页）不是滚动意图，不据此让位
    if (e.isComposing || e.key === "Process") return;
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(e.key))
      cancel();
  };
  window.addEventListener("wheel", cancel, { passive: true });
  window.addEventListener("touchstart", cancel, { passive: true });
  window.addEventListener("keydown", cancelKeys, true);
  // 恢复期间对到达页上锁：Next 滚顶残值不得覆盖「真实用户滚动」存档
  lockScroll(page);
  let attempts = 0;
  let stable = 0;
  timer = setInterval(() => {
    attempts += 1;
    if (Math.abs(window.scrollY - saved) > 4) {
      window.scrollTo(0, saved); // 对抗 Next 分次 commit 的滚顶
      stable = 0;
    } else {
      stable += 1;
      // 位置已稳 1.5s：恢复完成。不硬等满窗口——晚到的滚顶若在收尾后才来，
      // 只会滚顶一次（无人对抗），所以窗口长度才是对抗强度的来源，这里提前收尾无损。
      if (stable >= RESTORE_STABLE_TICKS) cancel();
    }
    if (attempts >= RESTORE_ATTEMPTS) cancel();
  }, RESTORE_DELAY_MS);
  activeRestoreStop = cancel;
}

/**
 * 历史导航（浏览器前进 / 后退）捕获、返回键动画与滚动恢复（M16 Step 2，docs/motion-spec.md §6.3）：
 *
 * - **来源捕获**：Navigation API 可用时在 URL 改变前记录 traverse 真实来源；popstate 登记
 *   「history 跳过」的动效会话（不伪装 push）。
 * - **返回键动画（M16-D1 intercept 路线）**：支持 Navigation API 的浏览器上，拦截同站**跨页**
 *   遍历、驱动状态级 fade——update 等 popstate（拦截的 handler 完成后浏览器才提交遍历），历史栈
 *   零污染（Step 0 实验①实证）；不支持时回退现状（诚实跳过）。同页历史移动（页内锚点 pushState
 *   写入的 hash 项往返）文档未变：播整页 fade 只剩噪声——不拦截、不播动效；返回恢复取锚点
 *   点击前钉住的存档（scroll-record），与浏览器「回到点击前位置」原生语义一致（Step 4.5）。
 * - **返回滚动恢复（Step 0 新发现的全站级缺陷修复）**：软导航的 history API 调用会丢弃浏览器
 *   的条目滚动存档，且 Next 的 ScrollHandler 在提交时会滚顶（其 scroll 事件若写入记录会把
 *   「用户在旧页的真实滚动」污染成滚顶残值）——因此：navigate（push/replace）派发瞬间快照
 *   当前页滚动并加导航锁（存档与锁在 scroll-record.ts），返回提交并渲染稳定后从存档取回
 *   「到达页」的最后用户滚动恢复。traverse 派发时浏览器已把 scrollY 归零，故返回场景的值
 *   只能来自持续记录。
 */
export function NavKindCapture() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const key = `${pathname}${search ? `?${search}` : ""}`;
  const motion = useSiteMotion();
  const currentPath = useRef(key);
  const traversal = useRef<{ from: string; to: string } | null>(null);

  useEffect(() => {
    currentPath.current = key;
    // 当前页滚动快照持续更新（rAF 对齐，sessionStorage 落盘按节流）；导航锁期间跳过（防滚顶污染）
    let scheduled = false;
    const record = () => {
      scheduled = false;
      const page = currentPath.current;
      if (scrollLockAlive(page)) return;
      recordScroll(page, window.scrollY);
    };
    const onScroll = () => {
      if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(record);
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    record();
    return () => {
      window.removeEventListener("scroll", onScroll);
      // 离开本页：停掉仍在跑的恢复循环，不得把恢复强滚带进下一个页面（Step 4.5 P1-2）
      cancelRestoreLoop();
    };
  }, [key]);

  // 整页导航的返回（正文 markdown 链接是普通 <a>，会整页跳转）：浏览器按 back_forward
  // 加载且滚动存档已被 Next 劫持清掉——挂载后按持久化记录恢复到达页滚动
  useEffect(() => {
    const navEntry = performance.getEntriesByType("navigation")[0] as
      PerformanceNavigationTiming | undefined;
    if (navEntry?.type !== "back_forward") return;
    const saved = getScrollRecord(key);
    if (saved <= 0) return;
    // 修复挂载时初始 record 写入的 0：锁 + 记录回填到真实用户滚动
    lockScroll(key);
    backfillScrollRecord(key, saved);
    runRestoreLoop(key, saved);
  }, [key]);

  useEffect(() => {
    const navigation = (window as unknown as { navigation?: EventTarget }).navigation;
    const currentKey = () => `${window.location.pathname}${window.location.search}`;
    const onNavigate = (raw: Event) => {
      const event = raw as Event & {
        navigationType?: string;
        destination?: { url: string };
        intercept(options: { handler: () => Promise<void> }): void;
      };
      const target = event.destination
        ? new URL(event.destination.url, window.location.href)
        : null;
      const to = target ? `${target.pathname}${target.search}` : null;
      const sameOrigin = target ? target.origin === window.location.origin : false;
      // push 开始：若点击捕获的锁未覆盖（程序化导航），补一次快照+锁。
      // replace（Next 记账，含返回时的 restore 写入）永不快照——它派发时 scrollY 已被
      // 滚顶污染（实证：返回 restore 的 replace 会把滚顶残值写进到达页记录）；
      // traverse 时 scrollY 已被浏览器归零，同样跳过。
      if (event.navigationType === "push" && to !== null) {
        const page = currentKey();
        if (!scrollLockAlive(page) && window.scrollY > 0) pinScrollAtCurrent();
      }
      if (event.navigationType === "traverse" && to !== null) {
        const from = currentKey();
        traversal.current = { from, to };
        // 返回键动画（intercept 路线，Step 0 实验①）：拦截遍历驱动状态级 fade；
        // update 等 popstate（拦截 handler 完成后浏览器才提交遍历），历史栈零污染。
        // 仅拦截同站且跨页的遍历（同页锚点往返见上）；intercept 以特性检测守卫
        // （jsdom / 不完整实现优雅回退诚实跳过），跨站遍历浏览器本就禁止 intercept，不越权。
        if (
          to.startsWith("/") &&
          sameOrigin &&
          from !== to &&
          typeof event.intercept === "function"
        ) {
          event.intercept({
            handler: async () => {
              const committed = new Promise<void>((resolve) => {
                window.addEventListener("popstate", () => resolve(), { once: true });
              });
              const root = document.documentElement;
              root.dataset.vt = "fade";
              const vt = document.startViewTransition(() => committed);
              try {
                await vt.finished.catch(() => {});
              } finally {
                delete root.dataset.vt;
              }
            },
          });
        }
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
      // 返回滚动恢复：滚动值取自持续记录（traverse 派发时 scrollY 已被浏览器归零，
      // 不能现场读）；Next 的 ScrollHandler 每次 commit 都会跑（含返回提交后的滚顶），
      // 恢复循环对抗覆盖；用户输入让位；换页/卸载统一取消（cancelRestoreLoop）。
      // 同页历史移动（页内锚点往返）同样恢复——存档是锚点点击前钉住的快照，
      // 返回即回到点击前位置（浏览器原生语义，Step 4.5）。
      const saved = getScrollRecord(to);
      if (saved > 0) runRestoreLoop(to, saved);
    };
    // 链接点击捕获：快照「离开页」的用户滚动并加锁——必须早于 Next 提交时的滚顶
    // （时序实证：滚顶先于 navigate(push) 事件派发，navigate 里做快照会存到污染值）
    const onClickCapture = (raw: Event) => {
      const anchor = (raw.target as Element | null)?.closest?.("a[href]");
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      if (!href.startsWith("/") || href.startsWith("//")) return;
      pinScrollAtCurrent();
    };
    const flush = () => flushScrollRecord();
    // 整页导航 / 转入后台前强制刷盘：滚动存档的节流落盘可能漏掉最后几帧
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushScrollRecord();
    };
    navigation?.addEventListener("navigate", onNavigate, true);
    window.addEventListener("popstate", onPop, true);
    document.addEventListener("click", onClickCapture, true);
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      navigation?.removeEventListener("navigate", onNavigate, true);
      window.removeEventListener("popstate", onPop, true);
      document.removeEventListener("click", onClickCapture, true);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [motion]);
  return null;
}
