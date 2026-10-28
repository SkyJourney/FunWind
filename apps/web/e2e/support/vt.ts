import type { Page } from "@playwright/test";

/**
 * View Transition 采样（M10.7 页面过渡 E2E 用）：
 * 浏览器对页面过渡的「实际动画」只能从 `document.getAnimations()` 里 `::view-transition-*` 伪元素上读到；
 * 这里在每个文档里注入一个常驻的 rAF 采样器（addInitScript，整页重载后依然在），
 * 并给 `document.startViewTransition` 打桩计数——后者回答「有没有启动过渡、方向与圆心是什么」，
 * 前者回答「播了什么动画」。
 */
export async function installTransitionProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type W = Window & {
      __vtRec?: Set<string>;
      __vtStarts?: (string | null)[];
      __vtOrigins?: ({ x: string; y: string } | null)[];
      __vtInstalled?: boolean;
    };
    const w = window as W;
    if (w.__vtInstalled) return;
    w.__vtInstalled = true;
    w.__vtRec = new Set();
    w.__vtStarts = [];
    w.__vtOrigins = [];
    const original = document.startViewTransition?.bind(document);
    if (original) {
      (document as unknown as { startViewTransition: typeof original }).startViewTransition = (
        arg?: Parameters<typeof original>[0],
      ) => {
        const root = document.documentElement;
        w.__vtStarts!.push(root.dataset.nav ?? null);
        // 扩散 / 收起的圆心（<html> 上的 --vt-x / --vt-y）
        const x = root.style.getPropertyValue("--vt-x");
        const y = root.style.getPropertyValue("--vt-y");
        w.__vtOrigins!.push(x && y ? { x, y } : null);
        return original(arg);
      };
    }
    const tick = () => {
      for (const a of document.getAnimations()) {
        const pseudo = (a.effect as KeyframeEffect | null)?.pseudoElement;
        const name = (a as CSSAnimation).animationName;
        // 只记页面内容组（_t_N_ 自动命名）与顶栏 / Tab 的命名组；root 与 ::view-transition 自身不关心
        if (pseudo?.startsWith("::view-transition") && name && !pseudo.includes("(root)")) {
          w.__vtRec!.add(`${pseudo.replace(/\(_t_\d+_\)/, "(page)")}|${name}`);
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** 清空记录（每次导航前调用） */
export async function resetTransitions(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __vtRec?: Set<string>;
      __vtStarts?: unknown[];
      __vtOrigins?: unknown[];
    };
    w.__vtRec?.clear();
    if (w.__vtStarts) w.__vtStarts.length = 0;
    if (w.__vtOrigins) w.__vtOrigins.length = 0;
  });
}

export interface TransitionReading {
  /** 每次 startViewTransition 启动时 <html data-nav> 的值 */
  starts: (string | null)[];
  /** 每次启动时 <html> 上的圆心（--vt-x / --vt-y，带 px 单位）；没有圆心为 null */
  origins: ({ x: string; y: string } | null)[];
  /** 记录到的动画：`伪元素|动画名`，页面内容组的自动命名统一写成 (page) */
  animations: string[];
}

export async function readTransitions(page: Page): Promise<TransitionReading> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __vtRec?: Set<string>;
      __vtStarts?: (string | null)[];
      __vtOrigins?: ({ x: string; y: string } | null)[];
    };
    return {
      starts: [...(w.__vtStarts ?? [])],
      origins: [...(w.__vtOrigins ?? [])],
      animations: [...(w.__vtRec ?? [])].sort(),
    };
  });
}
