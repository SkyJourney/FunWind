/**
 * 跳到令牌编辑器里某个颜色所在的行（M11.6 Step 3d，对比度面板的「定位」按钮用）。
 *
 * 行用 `data-token-key` 标记。滚到视口中间，聚焦行里第一个文本框（已覆盖）或「覆盖」按钮（继承）。
 * 大屏上预览是吸顶的，会盖住滚到上半屏的行：吸顶时把行再往下挪到吸顶区下沿以下，留 8px。
 * 找到了行返回 true。
 */
export function jumpToTokenRow(
  root: ParentNode | null,
  key: string,
  sticky: HTMLElement | null,
): boolean {
  if (!root) return false;
  const row = Array.from(root.querySelectorAll<HTMLElement>("[data-token-key]")).find(
    (element) => element.getAttribute("data-token-key") === key,
  );
  if (!row) return false;
  // 用 instant：站点若设了平滑滚动，下面量的位置会是滚动中途的
  row.scrollIntoView({ block: "center", behavior: "instant" });
  if (sticky && getComputedStyle(sticky).position === "sticky") {
    const covered = sticky.getBoundingClientRect().bottom - row.getBoundingClientRect().top;
    if (covered > 0) window.scrollBy({ top: -(covered + 8), behavior: "instant" });
  }
  row.querySelector<HTMLElement>('input[type="text"], button')?.focus({ preventScroll: true });
  return true;
}
