import { Children, cloneElement, isValidElement, type CSSProperties } from "react";
import { MOTION_DEFAULTS } from "./config";
import { MOTION_ELEMENT_PRESETS, MOTION_TOKENS } from "./presets";
import type { MotionListProps } from "./types";

/**
 * 元素层列表进场（M15 Step 3，docs/motion-spec.md §3）：声明式收编首屏错落与追加淡入。
 *
 * - 共享组件（无 "use client"）：只用 React 同构 API，服务端首屏即可挂类与延迟，RSC 页面直接包裹条目；
 * - 不新增包裹盒子：通过 cloneElement 把预设类与延迟合并进每个条目的根元素（条目须接受 className/style），
 *   DOM 结构与版式（grid / 分隔线 / :last-child）保持原样，静态视觉零变化；
 * - list.enter：前 maxStaggerItems 项挂 fw-enter，延迟 = calc(var(--fw-stagger-step) * 序号)，其余项不挂；
 * - list.append：每项挂 fw-fade-in，无延迟无位移（触底追加，M10.7 站长裁定）；
 * - animate=false：原样渲染 children（翻页 / 直达深页不重复播）；
 * - 时长 / 曲线 / 步长全部来自令牌层；reduce 下 fw-enter / fw-fade-in 由 globals.css 统一归零。
 */
export function MotionList({ children, preset = "list.enter", animate = true }: MotionListProps) {
  if (!animate) return <>{children}</>;
  const { className } = MOTION_ELEMENT_PRESETS[preset];
  const cap = preset === "list.enter" ? MOTION_DEFAULTS.maxStaggerItems : Number.POSITIVE_INFINITY;
  let index = 0;
  return (
    <>
      {Children.map(children, (child) => {
        if (!isValidElement<{ className?: string; style?: CSSProperties }>(child)) return child;
        const order = index++;
        if (order >= cap) return child;
        const style: CSSProperties = { ...child.props.style };
        if (preset === "list.enter") {
          style.animationDelay = `calc(${MOTION_TOKENS.stagger} * ${order})`;
        }
        return cloneElement(child, {
          className: child.props.className ? `${child.props.className} ${className}` : className,
          style,
        });
      })}
    </>
  );
}
