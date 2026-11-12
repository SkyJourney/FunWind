import { playStateTransition } from "@/lib/motion";
import type { ThemeValue } from "@/lib/theme";

/**
 * 主题/明暗切换的状态级 VT 交叉溶解（M16-D2，docs/motion-spec.md §6.3）：
 * 包住属性写入与偏好更新，整页快照约 250ms 交叉溶解；reduce / 无 API 时引擎自动降级为
 * 直接执行（内容永不阻塞）。与页面导航 VT（html[data-motion-direction]）互不干扰
 * ——本助手走 html[data-vt] 状态级机制（M15 playStateTransition 已验证）。
 *
 * 注意：next-themes 的 data-mode 属性写入发生在其 effect 里（异步）——VT 的新快照内
 * 必须同步落属性，所以这里先按目标值同步写 data-mode（system 就地按系统偏好解析），
 * setTheme 随后把 React 状态与存储对齐到同一值（其 effect 再写一次是幂等 no-op）。
 */
export function applyThemeWithTransition(
  setTheme: (value: ThemeValue) => void,
  value: ThemeValue,
): void {
  void playStateTransition(
    () => {
      const resolved =
        value === "system"
          ? window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light"
          : value;
      document.documentElement.dataset.mode = resolved;
      setTheme(value);
    },
    { kind: "fade" },
  );
}

/**
 * 主题包切换同款包装（M16-D2）：VT 内同步写 data-pack（CSS 只看属性，零重载）。
 * 偏好 setState 留在 VT 外（菜单勾选态下一帧更新，不进快照）；PATCH 失败的回滚
 * 保持直改（错误恢复路径不做二次过渡）。
 */
export function applyPackWithTransition(apply: () => void): void {
  void playStateTransition(apply, { kind: "fade" });
}
