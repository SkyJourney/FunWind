import type { ReactNode } from "react";
import { ViewTransition } from "react";

/**
 * 页面级过渡（M10.7 Step 4b）：用 React `<ViewTransition>` 包住页面内容，浏览器同时持有新旧两张快照，
 * 所以**进场与退场都能动**（旧的 template 内联动画只能进场）。具体动画由 `html[data-nav]` 选择
 * （push 自右切入 / pop 自左切入 / fade 淡入淡出），见 globals.css 的 `.fw-page-in` / `.fw-page-out`。
 * 进场与退场用**不同的类名**：旧页与新页是两个独立的过渡组，组与组之间的叠放由浏览器决定（新页在上），
 * 「收起」需要旧页盖在新页之上，只能单独给退场组抬高层级——类名不同才能分别选中。
 *
 * 为什么放在 template 而不是各个 page：template 每次导航都会重新挂载（进退场照样触发），
 * 且位于 layout 之内——顶栏、底部 Tab、页脚留在 layout 里，天然不在页面动画组里；一处挂载覆盖全站。
 * 仅查询串变化（如首页分区筛选 ?sec=）不会重挂载 template，所以不会触发页面切换动画。
 *
 * 为什么套一层全宽的 div：View Transition 的快照盒子 = 被命名元素自己的盒子。页面根（<main>）是居中的 max-w 容器，
 * 盒子左边不是 0，触点扩散的 clip-path 圆心就无法直接用视口坐标；包装 div 全宽、紧接在顶栏之后，盒子的左边恒为 0、
 * 顶部位置可测（data-fw-page），圆心换算（lib/motion/nav-kind.ts）才可靠。
 */
export default function Template({ children }: { children: ReactNode }) {
  return (
    <ViewTransition enter="fw-page-in" exit="fw-page-out" default="none">
      <div data-fw-page>{children}</div>
    </ViewTransition>
  );
}
