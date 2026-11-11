"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ComponentProps } from "react";
import { useSiteMotion } from "./motion-provider";
import { siteMotionDirection } from "./motion-routes";
import type { MotionNavigationDirection } from "./page-motion";

type LinkProps = ComponentProps<typeof Link> & { direction?: MotionNavigationDirection };
const transitionTypes = (direction: string, extra: readonly string[] = []) => [
  ...new Set([`fw-${direction}`, ...extra]),
];

export function MotionLink({ direction, transitionTypes: extra, href, ...props }: LinkProps) {
  const pathname = usePathname();
  const target = typeof href === "string" ? href : (href.pathname ?? pathname);
  const resolved = direction ?? siteMotionDirection(pathname, target);
  return (
    <Link
      {...props}
      href={href}
      data-motion-direction={direction}
      transitionTypes={transitionTypes(resolved, extra)}
    />
  );
}

type NavigateOptions = NonNullable<Parameters<ReturnType<typeof useRouter>["push"]>[1]> & {
  direction?: MotionNavigationDirection;
};
export function useMotionRouter() {
  const router = useRouter();
  const motion = useSiteMotion();
  const pathname = usePathname();
  const navigate = (method: "push" | "replace", href: string, options: NavigateOptions = {}) => {
    const { direction, transitionTypes: extra, ...rest } = options;
    if (motion.begin(href, direction) === false) return;
    router[method](href, {
      ...rest,
      transitionTypes: transitionTypes(direction ?? siteMotionDirection(pathname, href), extra),
    });
  };
  return {
    ...router,
    push: (href: string, options?: NavigateOptions) => navigate("push", href, options),
    replace: (href: string, options?: NavigateOptions) => navigate("replace", href, options),
  };
}
