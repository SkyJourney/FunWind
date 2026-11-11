"use client";

import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  ViewTransition,
  type ReactNode,
  type ViewTransitionInstance,
} from "react";
import type { MotionEngine } from "./runtime";
import type { MotionLifecycle, MotionPageProps, MotionScope } from "./types";

export interface MotionProviderProps {
  readonly engine: MotionEngine;
  readonly children: ReactNode;
  readonly onPageTransition?: (
    id: number,
    instance: ViewTransitionInstance,
    types: readonly string[],
  ) => void | (() => void);
}

const HostContext = createContext<Omit<MotionProviderProps, "children"> | null>(null);
const PageContext = createContext<string | null>(null);

export function MotionProvider({ engine, onPageTransition, children }: MotionProviderProps) {
  const host = useMemo(() => ({ engine, onPageTransition }), [engine, onPageTransition]);
  return <HostContext.Provider value={host}>{children}</HostContext.Provider>;
}

function useMotionHost() {
  const host = useContext(HostContext);
  if (!host) throw new Error("动效接入必须位于 MotionProvider 内");
  return host;
}

export function useMotion(): MotionEngine {
  return useMotionHost().engine;
}

export function useMotionLifecycle(hooks: MotionLifecycle, scope?: MotionScope): void {
  const engine = useMotion();
  const page = useContext(PageContext);
  const resolved = useMemo<MotionScope>(
    () => scope ?? (page === null ? { level: "global" } : { level: "page", page }),
    [scope, page],
  );
  useLayoutEffect(() => engine.register(resolved, hooks), [engine, resolved, hooks]);
}

/** key 只挂在 VT 本体上；不增加第二层快照盒子，SSR children 仍由服务端渲染。 */
export function MotionPage({ children, motionKey, pageKey, preset }: MotionPageProps) {
  const { engine, onPageTransition } = useMotionHost();
  const page = pageKey ?? String(motionKey);
  const session = engine.current;
  // 回调必须绑定这次渲染的导航编号，不能在晚到的旧回调里读取并认领新会话。
  const id = session?.target.page === page ? session.id : undefined;
  const participate = (instance: ViewTransitionInstance, types: string[]) => {
    if (id === undefined || engine.current?.id !== id) return;
    try {
      if (onPageTransition) return onPageTransition(id, instance, types);
      engine.ready(id);
      return () => {
        engine.finish(id);
      };
    } catch (error) {
      engine.skip(id, "transition-error");
      console.warn("[motion] 页面过渡适配失败", error);
    }
  };
  return (
    <PageContext.Provider value={page}>
      <ViewTransition
        key={motionKey}
        enter="fw-page-in"
        exit="fw-page-out"
        update="none"
        default="none"
        onEnter={participate}
        onExit={participate}
      >
        <div data-fw-page data-motion-preset={preset}>
          {children}
        </div>
      </ViewTransition>
    </PageContext.Provider>
  );
}
