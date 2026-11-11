import type { MotionDirection, MotionElementPreset, MotionPagePreset } from "./types";

export const MOTION_TOKENS = Object.freeze({
  fast: "var(--fw-dur-fast)",
  base: "var(--fw-dur-base)",
  slow: "var(--fw-dur-slow)",
  spring: "var(--fw-dur-spring)",
  out: "var(--fw-ease-out)",
  inout: "var(--fw-ease-inout)",
  bounce: "var(--fw-ease-spring)",
  exit: "var(--fw-ease-exit)",
  pageShift: "var(--fw-page-shift)",
  tabShift: "var(--fw-tab-shift)",
  stagger: "var(--fw-stagger-step)",
  floatDuration: "var(--fw-dur-float-up)",
});

export interface MotionAnimation {
  readonly name: string;
  readonly duration: string;
  readonly easing: string;
  readonly delay?: string;
}

const t = MOTION_TOKENS;
const animation = (name: string, duration: string, easing: string, delay?: string) =>
  Object.freeze({ name, duration, easing, ...(delay ? { delay } : {}) });
const pair = (enter: MotionAnimation | null, exit: MotionAnimation | null, oldOnTop = false) =>
  Object.freeze({ enter, exit, oldOnTop });

export const MOTION_DIRECTIONS = Object.freeze({
  fade: pair(
    animation("vt-page-fade-in", t.base, t.out),
    animation("vt-page-fade-out", t.fast, t.exit),
  ),
  push: pair(
    animation("vt-page-in-right", t.slow, t.out),
    animation("vt-page-out-left", t.fast, t.exit),
  ),
  pop: pair(
    animation("vt-page-in-left", t.slow, t.out),
    animation("vt-page-out-right", t.fast, t.exit),
  ),
  "tab-next": pair(
    animation("vt-tab-in-right", t.slow, t.out, `calc(${t.fast} / 2)`),
    animation("vt-tab-out-left", t.base, t.exit),
  ),
  "tab-prev": pair(
    animation("vt-tab-in-left", t.slow, t.out, `calc(${t.fast} / 2)`),
    animation("vt-tab-out-right", t.base, t.exit),
  ),
  expand: pair(animation("vt-page-expand", t.spring, t.inout), null),
  collapse: pair(null, animation("vt-page-collapse", t.slow, t.inout), true),
} satisfies Record<MotionDirection, ReturnType<typeof pair>>);

export const MOTION_PAGE_PRESETS = Object.freeze({
  list: Object.freeze({ direction: "auto" }),
  detail: Object.freeze({ direction: "auto" }),
  form: Object.freeze({ direction: "auto" }),
  admin: Object.freeze({ direction: "fade" }),
} satisfies Record<MotionPagePreset, { readonly direction: "auto" | MotionDirection }>);

export const MOTION_ELEMENT_PRESETS = Object.freeze({
  "list.enter": Object.freeze({ className: "fw-enter", duration: t.base, easing: t.out }),
  "list.append": Object.freeze({ className: "fw-fade-in", duration: t.base, easing: t.out }),
  pop: Object.freeze({ className: "fw-pop", duration: t.spring, easing: t.bounce }),
  "float-up": Object.freeze({ className: "fw-float-up", duration: t.floatDuration, easing: t.out }),
} satisfies Record<
  MotionElementPreset,
  { readonly className: string; readonly duration: string; readonly easing: string }
>);
