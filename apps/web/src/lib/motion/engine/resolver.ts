import type { MotionConfig } from "./config";
import { MOTION_PAGE_PRESETS } from "./presets";
import type {
  MotionDirection,
  MotionIntent,
  MotionPageDeclaration,
  MotionPlan,
  MotionRegistry,
  MotionRoute,
  MotionSelection,
} from "./types";

/** 输入为站内路径；查询串与 hash 不影响页面层级。 */
export function motionPathname(path: string): string {
  return path.split(/[?#]/, 1)[0] || "/";
}

export function createMotionRegistry(routes: readonly MotionRoute[] = []): MotionRegistry {
  const rules = routes.map(({ pattern, page }) => {
    if (pattern.global || pattern.sticky) throw new TypeError("动效路由规则不能使用有状态的正则");
    return { pattern: new RegExp(pattern.source, pattern.flags), page: Object.freeze({ ...page }) };
  });
  return Object.freeze({
    resolve(path: string) {
      return rules.find((rule) => rule.pattern.test(motionPathname(path)))?.page;
    },
  });
}

export function directionBetween(
  from?: MotionPageDeclaration,
  to?: MotionPageDeclaration,
): MotionDirection {
  if (from?.tabOrder !== undefined && to?.tabOrder !== undefined && from.tabOrder !== to.tabOrder) {
    return to.tabOrder > from.tabOrder ? "tab-next" : "tab-prev";
  }
  if (from?.level === undefined || to?.level === undefined || from.level === to.level)
    return "fade";
  return to.level > from.level ? "push" : "pop";
}

export function resolveMotionPlan(
  intent: MotionIntent,
  registry: MotionRegistry,
  config: MotionConfig,
  targetPage?: MotionPageDeclaration,
  selection: MotionSelection = {},
): MotionPlan {
  const from = registry.resolve(intent.from);
  const to = targetPage ?? registry.resolve(intent.to);
  const preset = selection.preset ?? intent.preset ?? to?.preset ?? config.pagePreset;
  const preferred = MOTION_PAGE_PRESETS[preset].direction;
  const direction =
    selection.direction ??
    intent.direction ??
    (preferred === "auto" ? directionBetween(from, to) : preferred);
  return Object.freeze({
    direction,
    preset,
    ...(intent.origin ? { origin: Object.freeze({ ...intent.origin }) } : {}),
  });
}
