import type { ReactNode } from "react";
import { ViewTransition } from "react";

/**
 * 页面级过渡（M10.7 Step 4b）：用 React `<ViewTransition>` 包住页面内容，浏览器同时持有新旧两张快照，
 * 所以**进场与退场都能动**（旧的 template 内联动画只能进场）。具体动画由 `html[data-nav]` 选择
 * （push 自右切入 / pop 自左切入 / fade 淡入淡出），见 globals.css 的 `.fw-page`。
 *
 * 为什么放在 template 而不是各个 page：template 每次导航都会重新挂载（进退场照样触发），
 * 且位于 layout 之内——顶栏、底部 Tab、页脚留在 layout 里，天然不在页面动画组里；一处挂载覆盖全站。
 * 仅查询串变化（如首页分区筛选 ?sec=）不会重挂载 template，所以不会触发页面切换动画。
 */
export default function Template({ children }: { children: ReactNode }) {
  return (
    <ViewTransition enter="fw-page" exit="fw-page" default="none">
      {children}
    </ViewTransition>
  );
}
