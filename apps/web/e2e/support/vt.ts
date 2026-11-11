import type { Page } from "@playwright/test";

/** 同时保留规范化动画名与原始快照组，后者用于识别重复页面边界，不能用 Set 去重后的名字数猜组数。 */
export async function installTransitionProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type W = Window & {
      __vtRec?: Set<string>;
      __vtRaw?: Set<string>;
      __vtTypes?: string[][];
      __vtStarts?: (string | null)[];
      __vtOrigins?: ({ x: string; y: string } | null)[];
      __vtInstalled?: boolean;
      __vtLastFinished?: Promise<void>;
    };
    const w = window as W;
    if (w.__vtInstalled) return;
    w.__vtInstalled = true;
    w.__vtRec = new Set();
    w.__vtRaw = new Set();
    w.__vtTypes = [];
    w.__vtStarts = [];
    w.__vtOrigins = [];
    const original = document.startViewTransition?.bind(document);
    if (original) {
      (document as unknown as { startViewTransition: typeof original }).startViewTransition = (
        arg?: Parameters<typeof original>[0],
      ) => {
        const root = document.documentElement;
        w.__vtStarts!.push(root.dataset.motionDirection ?? null);
        const typeIndex = w.__vtTypes!.length;
        w.__vtTypes!.push(
          typeof arg === "object" && arg !== null ? Array.from(arg.types ?? []) : [],
        );
        const x = root.style.getPropertyValue("--vt-x");
        const y = root.style.getPropertyValue("--vt-y");
        w.__vtOrigins!.push(x && y ? { x, y } : null);
        const transition = original(arg);
        w.__vtLastFinished = transition.finished.catch(() => {});
        void transition.ready.then(
          () => {
            if (transition.types) w.__vtTypes![typeIndex] = Array.from(transition.types);
          },
          () => {},
        );
        return transition;
      };
    }
    const tick = () => {
      for (const a of document.getAnimations()) {
        const pseudo = (a.effect as KeyframeEffect | null)?.pseudoElement;
        const name = (a as CSSAnimation).animationName;
        if (pseudo?.startsWith("::view-transition") && name && !pseudo.includes("(root)")) {
          w.__vtRec!.add(`${pseudo.replace(/\(_t_\d+_\)/, "(page)")}|${name}`);
          w.__vtRaw!.add(`${pseudo}|${name}`);
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

export async function resetTransitions(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __vtRec?: Set<string>;
      __vtRaw?: Set<string>;
      __vtTypes?: string[][];
      __vtStarts?: unknown[];
      __vtOrigins?: unknown[];
    };
    w.__vtRec?.clear();
    w.__vtRaw?.clear();
    if (w.__vtTypes) w.__vtTypes.length = 0;
    if (w.__vtStarts) w.__vtStarts.length = 0;
    if (w.__vtOrigins) w.__vtOrigins.length = 0;
  });
}

export interface TransitionReading {
  starts: (string | null)[];
  origins: ({ x: string; y: string } | null)[];
  animations: string[];
  rawAnimations: string[];
  transitionTypes: string[][];
}

export async function readTransitions(page: Page): Promise<TransitionReading> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __vtRec?: Set<string>;
      __vtRaw?: Set<string>;
      __vtTypes?: string[][];
      __vtStarts?: (string | null)[];
      __vtOrigins?: ({ x: string; y: string } | null)[];
    };
    return {
      starts: [...(w.__vtStarts ?? [])],
      origins: [...(w.__vtOrigins ?? [])],
      animations: [...(w.__vtRec ?? [])].sort(),
      rawAnimations: [...(w.__vtRaw ?? [])].sort(),
      transitionTypes: [...(w.__vtTypes ?? [])],
    };
  });
}
