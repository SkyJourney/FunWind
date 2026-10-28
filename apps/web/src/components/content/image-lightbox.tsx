"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/**
 * 帖子图片点击放大（M10.6d 站长反馈）：content-md 内非表情图点击 → 全屏查看。
 * 轻量原生 <dialog>（零依赖）：居中适配视口、点任意处/Esc 关闭、移动端长按可存图；
 * 监听挂在最近的内容祖先（RichContent 的 div），capture 先于链接导航。
 * 触发目标为 .content-md img 且 src 不含 /emoji/（表情保持行内小图不放大）。
 */
export function ImageLightbox({ selector }: { selector: string }) {
  const dlgRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dlg = dlgRef.current;
    if (!dlg) return;

    // 监听挂在 dialog 的父节点（= portal 目标 body 下 RichContent 的兄弟位置不可行，
    // 改为文档级 capture：选择器已限定 .content-md img，误伤面为零）
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
    document.addEventListener("click", onClick, true);
    const onDlgClick = () => {
      dlg.close(); // 点图片或遮罩任意处关闭
    };
    dlg.addEventListener("click", onDlgClick);
    return () => {
      document.removeEventListener("click", onClick, true);
      dlg.removeEventListener("click", onDlgClick);
    };
  }, [selector]);

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
