import type { ReactNode } from "react";

export type MotionDirection =
  "push" | "pop" | "fade" | "tab-next" | "tab-prev" | "expand" | "collapse";
export type MotionPagePreset = "list" | "detail" | "form" | "admin";
export type MotionElementPreset = "list.enter" | "list.append" | "pop" | "float-up";
export type MotionSource = "link" | "programmatic" | "history";
export type MotionSkipReason =
  | "disabled"
  | "cancelled"
  | "reduced-motion"
  | "no-api"
  | "history"
  | "same-page"
  | "interrupted"
  | "timeout"
  | "disposed"
  | "transition-error"
  | "update-error";

export interface MotionPageDeclaration {
  readonly preset: MotionPagePreset;
  readonly level?: number;
  readonly tabOrder?: number;
}

export interface MotionOrigin {
  readonly x: number;
  readonly y: number;
  readonly r?: number;
}

export interface MotionSelection {
  readonly direction?: MotionDirection;
  readonly preset?: MotionPagePreset;
}

export interface MotionIntent extends MotionSelection {
  readonly from: string;
  readonly to: string;
  readonly source: MotionSource;
  readonly origin?: MotionOrigin;
}

export interface MotionRoute {
  readonly pattern: RegExp;
  readonly page: MotionPageDeclaration;
}

export interface MotionRegistry {
  resolve(pathname: string): MotionPageDeclaration | undefined;
}

export interface MotionPlan {
  readonly direction: MotionDirection;
  readonly preset: MotionPagePreset;
  readonly origin?: MotionOrigin;
}

export type MotionScope =
  | { readonly level: "global" }
  | { readonly level: "page"; readonly page: string }
  | { readonly level: "element"; readonly page: string; readonly element: string };

export interface MotionTarget {
  readonly page?: string;
  readonly element?: string;
}

export interface MotionContext {
  readonly id: number;
  readonly intent: MotionIntent;
  readonly target: MotionTarget;
  readonly plan: MotionPlan;
}

export interface MotionElementContext extends MotionTarget {
  readonly element: string;
  readonly node: Element;
}

export interface MotionLifecycle {
  onIntent?(context: MotionContext): MotionSelection | false | void;
  onBeforeTransition?(context: MotionContext): void;
  onReady?(context: MotionContext): void;
  onFinish?(context: MotionContext): void;
  onSkip?(context: MotionContext, reason: MotionSkipReason): void;
  onEnter?(context: MotionElementContext): void;
  onInView?(context: MotionElementContext): void;
  onExit?(context: MotionElementContext): void;
  onUpdate?(context: MotionElementContext): void;
}

export type MotionHookName = keyof MotionLifecycle;
export type MotionReporter = (error: unknown, hook: MotionHookName) => void;
export type MotionElementEvent = "onEnter" | "onInView" | "onExit" | "onUpdate";
export type MotionSchedule = (callback: () => void, delayMs: number) => () => void;
export type MotionUpdate = () => void | Promise<void>;

export interface MotionDriver {
  start(
    update: () => Promise<void>,
    plan: MotionPlan,
  ): { readonly ready: PromiseLike<void>; readonly finished: PromiseLike<void> };
}

/** 只声明接入类型；组件与 hook 在页面层、元素层迁移时落地。 */
export interface MotionPageProps extends Partial<MotionPageDeclaration> {
  readonly children: ReactNode;
  readonly motionKey: string | number;
}
export interface MotionListProps {
  readonly children: ReactNode;
  readonly preset?: Extract<MotionElementPreset, "list.enter" | "list.append">;
}
