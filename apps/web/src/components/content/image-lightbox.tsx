"use client";

import { useEffect, useState } from "react";
import Lightbox from "yet-another-react-lightbox";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import "yet-another-react-lightbox/styles.css";

/**
 * 帖子图片点击放大（M10.6d 站长反馈：要缩放工具/关闭按钮/遮罩点击关闭）：
 * yet-another-react-lightbox + Zoom 插件（工具条缩放/滚轮/双击）；自带关闭按钮、遮罩点击、Esc、滑动。
 *
 * 关键设计：RichContent 每楼层渲染一个 <ImageLightbox>，若各自持有 open state，
 * 一帖 20 楼会叠 20 个全屏容器——点关闭只卸载一个，其余仍盖在屏上（站长实测的「关不掉」）。
 * 改为模块级事件总线：图片点击派发 open 事件，全页只此一个全屏实例统一渲染/统一关闭。
 * 表情小图不挂接（selector 排除 /emoji/）。
 */

interface LightboxOpenEvent {
  slides: { src: string }[];
  index: number;
}

const OPEN_EVENT = "fw-image-lightbox-open";

export function openImageLightbox(slides: { src: string }[], index: number): void {
  window.dispatchEvent(
    new CustomEvent<LightboxOpenEvent>(OPEN_EVENT, { detail: { slides, index } }),
  );
}

/** 全页唯一实例：由 RichContent 渲染（每楼层一份也只挂一个监听器，事件只被首个实例消费前先去重）。 */
export function ImageLightbox({ selector }: { selector: string }) {
  const [state, setState] = useState<LightboxOpenEvent | null>(null);

  useEffect(() => {
    const onOpen = (e: Event) => setState((e as CustomEvent<LightboxOpenEvent>).detail);
    window.addEventListener(OPEN_EVENT, onOpen);

    // 图片点击 → 收集本帖全部内容图作为画廊 → 派发打开事件（capture 先于链接导航）
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName !== "IMG") return;
      if (!target.matches(selector)) return;
      e.preventDefault();
      const gallery = Array.from(document.querySelectorAll<HTMLElement>(selector)).map((el) => ({
        src: el.getAttribute("src") ?? "",
      }));
      const idx = gallery.findIndex((s) => s.src === target.getAttribute("src"));
      openImageLightbox(gallery, idx >= 0 ? idx : 0);
    };
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener(OPEN_EVENT, onOpen);
      document.removeEventListener("click", onClick, true);
    };
  }, [selector]);

  if (!state) return null;

  return (
    <Lightbox
      open
      index={state.index}
      slides={state.slides}
      close={() => setState(null)}
      plugins={[Zoom]}
      animation={{ swipe: 300 }}
      controller={{ closeOnBackdropClick: true }}
    />
  );
}
