import { createMotionRegistry, directionBetween, type MotionRoute } from "@/lib/motion";

const TAB_PATHS = [
  "/",
  "/boards",
  "/follows",
  "/search",
  "/submit",
  "/messages",
  "/notifications",
  "/me",
  "/login",
] as const;
const roots = "boards|follows|search|messages|notifications|points|me|submit|settings";

/** 方向语义单一事实源（M15 Step 4 退役 rank 表）；规则优先级按具体路径→分组，注册表不反向依赖业务查询。 */
export const SITE_MOTION_ROUTES: readonly MotionRoute[] = [
  ...TAB_PATHS.map((path, tabOrder): MotionRoute => ({
    pattern: new RegExp(`^${path}$`),
    page: {
      preset: path === "/login" ? "form" : "list",
      tabOrder,
      ...(path === "/login" ? {} : { level: path === "/" ? 0 : 1 }),
    },
  })),
  { pattern: /^\/(f|u)\/[^/]+$/, page: { preset: "list", level: 2 } },
  { pattern: /^\/(f|u)\/[^/]+\//, page: { preset: "form", level: 3 } },
  { pattern: /^\/t\/[^/]+/, page: { preset: "detail", level: 3 } },
  { pattern: /^\/a$/, page: { preset: "list", level: 1 } },
  { pattern: /^\/a\/[^/]+$/, page: { preset: "detail", level: 2 } },
  // 后台整体路由组默认 fade 微动（保持克制，M15 Step 4）：admin 预设方向恒 fade，不随层级 push/pop
  { pattern: /^\/admin\/?$/, page: { preset: "admin", level: 1 } },
  { pattern: /^\/admin\//, page: { preset: "admin", level: 2 } },
  { pattern: new RegExp(`^/(${roots})/?$`), page: { preset: "list", level: 1 } },
  { pattern: new RegExp(`^/(${roots})/`), page: { preset: "list", level: 2 } },
];

export const siteMotionRegistry = createMotionRegistry(SITE_MOTION_ROUTES);

export function siteMotionDirection(from: string, to: string) {
  return directionBetween(siteMotionRegistry.resolve(from), siteMotionRegistry.resolve(to));
}

/** 共享 layout 组（admin/settings）：根边界不重挂共享壳，页面层另下沉 keyed VT 边界做组内过渡。 */
export function hasSharedLayout(path: string): boolean {
  const pathname = path.split(/[?#]/, 1)[0];
  return /^\/(admin|settings)(\/|$)/.test(pathname ?? "");
}
