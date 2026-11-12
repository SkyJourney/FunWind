"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useSiteMotion } from "./motion-provider";

/**
 * 历史导航（浏览器前进 / 后退）捕获、返回键动画与滚动恢复（M16 Step 2，docs/motion-spec.md §6.3）：
 *
 * - **来源捕获**：Navigation API 可用时在 URL 改变前记录 traverse 真实来源；popstate 登记
 *   「history 跳过」的动效会话（不伪装 push）。
 * - **返回键动画（M16-D1 intercept 路线）**：支持 Navigation API 的浏览器上，拦截同站遍历、
 *   驱动状态级 fade——update 等 popstate（拦截的 handler 完成后浏览器才提交遍历），历史栈
 *   零污染（Step 0 实验①实证）；不支持时回退现状（诚实跳过）。
 * - **返回滚动恢复（Step 0 新发现的全站级缺陷修复）**：软导航的 history API 调用会丢弃浏览器
 *   的条目滚动存档，且 Next 的 ScrollHandler 在提交时会滚顶（其 scroll 事件若写入记录会把
 *   「用户在旧页的真实滚动」污染成滚顶残值）——因此：navigate（push/replace）派发瞬间快照
 *   当前页滚动并加导航锁，锁期间（约 1.2s，覆盖提交+滚顶）忽略该页的记录覆盖；返回提交并
 *   渲染稳定后从记录取回「到达页」的最后用户滚动恢复。traverse 派发时浏览器已把 scrollY
 *   归零，故返回场景的值只能来自持续记录。
 */

/** 恢复窗口：流式页面（RSC 分次 commit）的 Next 滚顶会晚到多次，窗口须覆盖整个流式周期 */
const RESTORE_ATTEMPTS = 40;
const RESTORE_DELAY_MS = 100;
/** 滚动记录容量上限：只保留最近的条目，防长会话无限增长 */
const SCROLL_MAP_MAX = 64;
/** 导航锁时长：覆盖「提交 + ScrollHandler 滚顶」窗口，过期后恢复常规记录 */
const NAV_LOCK_MS = 4000;
/** 滚动记录的 sessionStorage 键：整页导航（正文 markdown 链接是普通 <a>）后仍在同标签存活 */
const SCROLL_STORE_KEY = "fw-scroll-map";

/** 从 sessionStorage 读滚动记录（SSR / 存储不可用时为空表） */
function loadScrollMap(): Map<string, number> {
  const map = new Map<string, number>();
  if (typeof window === "undefined") return map;
  try {
    const raw = window.sessionStorage.getItem(SCROLL_STORE_KEY);
    if (raw)
      for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, number>)) map.set(k, v);
  } catch {
    // 存储不可用：软导航路径仍可用（内存表）
  }
  return map;
}

function saveScrollMap(map: Map<string, number>): void {
  try {
    window.sessionStorage.setItem(SCROLL_STORE_KEY, JSON.stringify(Object.fromEntries(map)));
  } catch {
    // 存储不可用：跳过持久化
  }
}

export function NavKindCapture() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const key = `${pathname}${search ? `?${search}` : ""}`;
  const motion = useSiteMotion();
  const currentPath = useRef(key);
  const traversal = useRef<{ from: string; to: string } | null>(null);
  /** 各页最后已知用户滚动（sessionStorage 持久化：整页导航的返回也能恢复）；写满时删最旧 */
  const scrollByPage = useRef<Map<string, number>>(loadScrollMap());
  /** 导航锁：离开页 + 截止时间（锁期间忽略该页的记录覆盖，防 Next 滚顶污染） */
  const navLock = useRef<{ page: string; until: number } | null>(null);

  useEffect(() => {
    currentPath.current = key;
    // 当前页滚动快照持续更新（节流：rAF 对齐）；导航锁期间跳过（防滚顶污染）
    let scheduled = false;
    const record = () => {
      scheduled = false;
      const page = currentPath.current;
      const lock = navLock.current;
      if (lock && lock.page === page && performance.now() < lock.until) return;
      const map = scrollByPage.current;
      if (map.size >= SCROLL_MAP_MAX) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
      map.set(page, window.scrollY);
      saveScrollMap(map);
    };
    const onScroll = () => {
      if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(record);
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    record();
    return () => window.removeEventListener("scroll", onScroll);
  }, [key]);

  // 整页导航的返回（正文 markdown 链接是普通 <a>，会整页跳转）：浏览器按 back_forward
  // 加载且滚动存档已被 Next 劫持清掉——挂载后按持久化记录恢复到达页滚动
  useEffect(() => {
    const navEntry = performance.getEntriesByType("navigation")[0] as
      PerformanceNavigationTiming | undefined;
    if (navEntry?.type !== "back_forward") return;
    const saved = scrollByPage.current.get(key) ?? 0;
    if (saved <= 0) return;
    // 修复挂载时初始 record 写入的 0：锁 + 记录回填到真实用户滚动
    navLock.current = { page: key, until: performance.now() + NAV_LOCK_MS };
    scrollByPage.current.set(key, saved);
    saveScrollMap(scrollByPage.current);
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      if (Math.abs(window.scrollY - saved) > 4) window.scrollTo(0, saved);
      if (attempts >= RESTORE_ATTEMPTS) clearInterval(timer);
    }, RESTORE_DELAY_MS);
    return () => clearInterval(timer);
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
      // 滚顶污染（实证：返回 restore 的 replace 会把滚顶残值 72 写进到达页记录）；
      // traverse 时 scrollY 已被浏览器归零，同样跳过。
      if (event.navigationType === "push" && to !== null) {
        const page = currentKey();
        const lock = navLock.current;
        const locked = lock && lock.page === page && performance.now() < lock.until;
        if (!locked && window.scrollY > 0) {
          scrollByPage.current.set(page, window.scrollY);
          navLock.current = { page, until: performance.now() + NAV_LOCK_MS };
        }
      }
      if (event.navigationType === "traverse" && to !== null) {
        traversal.current = { from: currentKey(), to };
        // 返回键动画（intercept 路线，Step 0 实验①）：拦截遍历驱动状态级 fade；
        // update 等 popstate（拦截 handler 完成后浏览器才提交遍历），历史栈零污染。
        // 仅拦截同站遍历；intercept 以特性检测守卫（jsdom / 不完整实现优雅回退诚实跳过），
        // 跨站遍历浏览器本就禁止 intercept，不越权。
        if (to.startsWith("/") && sameOrigin && typeof event.intercept === "function") {
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
      // 对到达页加导航锁防记录污染，并在滚顶窗口之后强制恢复、循环兜底对抗后续覆盖。
      const saved = scrollByPage.current.get(to) ?? 0;
      if (saved > 0) {
        navLock.current = { page: to, until: performance.now() + NAV_LOCK_MS };
        // 用户真实输入（滚轮 / 触摸 / 滚动键）立即让位：取消恢复循环，尊重用户新意图
        const cancel = () => {
          clearInterval(timer);
          window.removeEventListener("wheel", cancel);
          window.removeEventListener("touchstart", cancel);
          window.removeEventListener("keydown", cancelKeys);
        };
        const cancelKeys = (raw: Event) => {
          const key = (raw as KeyboardEvent).key;
          if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(key))
            cancel();
        };
        window.addEventListener("wheel", cancel, { passive: true });
        window.addEventListener("touchstart", cancel, { passive: true });
        window.addEventListener("keydown", cancelKeys, true);
        let attempts = 0;
        const timer = setInterval(() => {
          attempts += 1;
          if (Math.abs(window.scrollY - saved) > 4) {
            window.scrollTo(0, saved); // 对抗 Next 分次 commit 的滚顶，持续恢复
          }
          if (attempts >= RESTORE_ATTEMPTS) cancel();
        }, RESTORE_DELAY_MS);
      }
    };
    navigation?.addEventListener("navigate", onNavigate, true);
    window.addEventListener("popstate", onPop, true);
    // 链接点击捕获：快照「离开页」的用户滚动并加锁——必须早于 Next 提交时的滚顶
    // （时序实证：滚顶先于 navigate(push) 事件派发，navigate 里做快照会存到污染值）
    const onClickCapture = (raw: Event) => {
      const anchor = (raw.target as Element | null)?.closest?.("a[href]");
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      if (!href.startsWith("/") || href.startsWith("//")) return;
      const page = currentKey();
      // 取最大值：用户代理（Playwright 等）点击前会把元素滚入视口（上滚），
      // 不能让它覆盖用户已滚到的更深位置
      const prev = scrollByPage.current.get(page) ?? 0;
      scrollByPage.current.set(page, Math.max(prev, window.scrollY));
      navLock.current = { page, until: performance.now() + NAV_LOCK_MS };
    };
    document.addEventListener("click", onClickCapture, true);
    return () => {
      navigation?.removeEventListener("navigate", onNavigate, true);
      window.removeEventListener("popstate", onPop, true);
      document.removeEventListener("click", onClickCapture, true);
    };
  }, [motion]);
  return null;
}
