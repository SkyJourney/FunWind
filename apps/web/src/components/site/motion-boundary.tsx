"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { MotionPage } from "@/lib/motion";
import { isMotionPilot, siteMotionRegistry } from "./motion-routes";

export function SiteMotionBoundary({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const pilot = isMotionPilot(pathname);
  return (
    <MotionPage
      motionKey={pilot ? `page:${pathname}` : "root-fallback"}
      pageKey={pathname}
      preset={pilot ? siteMotionRegistry.resolve(pathname)?.preset : undefined}
    >
      {children}
    </MotionPage>
  );
}
