"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/**
 * 帖子图片点击放大（M10.6d 站长反馈）：content-md 内非表情图点击 → 全屏查看。
 * 轻量原生 <dialog>（零依赖）：居中适配视口、点任意处/Esc 关闭、移动端长按可存图；
 * 触发目标为 .content-md img 且 src 不含 /emoji/（表情保持行内小图不放大）。
 */
export function ImageLightbox({ selector }: { selector: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const dlgRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    const dlg = dlgRef.current;
    if (!root || !dlg) return;

    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName !== "IMG") return;
      if (!target.matches(selector)) return;
      e.preventDefault();
      const img = dlg.querySelector("img");
      if (img) {
        img.src = target.getAttribute("src") ?? "";
        img.alt = target.getAttribute("alt") ?? "";
      }
      dlg.showModal();
    };
    // capture：内容图可能在链接内，先于链接导航拦截
    root.addEventListener("click", onClick, true);
    const onDlgClick = () => {
      dlg.close(); // 点图片或遮罩任意处关闭
    };
    dlg.addEventListener("click", onDlgClick);
    return () => {
      root.removeEventListener("click", onClick, true);
      dlg.removeEventListener("click", onDlgClick);
    };
  }, [selector]);

  if (typeof document === "undefined") return null;

  return createPortal(
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- 对话框本体即点击关闭目标
    <dialog
      ref={dlgRef}
      className="fixed inset-0 z-100 m-auto h-full w-full max-w-none border-0 bg-black/85 p-0 open:flex open:items-center open:justify-center"
    >
      <img alt="" className="max-h-[92vh] max-w-[96vw] cursor-zoom-out object-contain" />
    </dialog>,
    document.body,
  );
}
