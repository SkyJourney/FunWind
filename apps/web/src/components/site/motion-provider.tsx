"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { MotionProvider } from "@/lib/motion";
import { createPageMotion, type PageMotion } from "./page-motion";

const SiteMotionContext = createContext<PageMotion | null>(null);

export function SiteMotionProvider({ children }: { children: ReactNode }) {
  const [motion] = useState(() => createPageMotion());
  // StrictMode 会清理后再次挂载 effect，不能在此永久 dispose 可复用的实例。
  useEffect(() => () => motion.cancel("disposed"), [motion]);
  return (
    <SiteMotionContext.Provider value={motion}>
      <MotionProvider engine={motion.engine} onPageTransition={motion.participate}>
        {children}
      </MotionProvider>
    </SiteMotionContext.Provider>
  );
}

export function useSiteMotion(): PageMotion {
  const motion = useContext(SiteMotionContext);
  if (!motion) throw new Error("站点动效必须位于 SiteMotionProvider 内");
  return motion;
}
