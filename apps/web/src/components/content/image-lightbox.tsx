"use client";

import { useEffect, useState } from "react";
import Lightbox from "yet-another-react-lightbox";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import "yet-another-react-lightbox/styles.css";

/**
 * 帖子图片点击放大（M10.6d 站长反馈：要缩放工具/关闭按钮/遮罩点击关闭）：
 * yet-another-react-lightbox + Zoom 插件（工具条缩放/滚轮/双击）；自带关闭按钮、遮罩点击、Esc、滑动。
 *
 * 架构约束（站长实测教训，勿改回）：楼层级 RichContent 每个都会渲染本组件——若每个实例各自挂
 * document click 监听 + open state，一次点击会让 N 个全屏 lightbox 叠加（点关闭只卸一层，其余仍盖屏）。
 * 因此点击监听只在**每页渲染一次**的本组件上挂（使用方把 <ImageLightbox /> 放在楼层循环之外），
 * 楼层内的图片点击经文档级 capture 命中这里；表情小图由选择器排除。
 */

interface LightboxOpenEvent {
  slides: { src: string }[];
  index: number;
}

const IMG_SELECTOR = ".content-md img:not([src*='/emoji/'])";

export function ImageLightbox() {
  const [state, setState] = useState<LightboxOpenEvent | null>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName !== "IMG") return;
      if (!target.matches(IMG_SELECTOR)) return;
      e.preventDefault();
      const gallery = Array.from(document.querySelectorAll<HTMLElement>(IMG_SELECTOR)).map(
        (el) => ({ src: el.getAttribute("src") ?? "" }),
      );
      const idx = gallery.findIndex((s) => s.src === target.getAttribute("src"));
      setState({ slides: gallery, index: idx >= 0 ? idx : 0 });
    };
    // capture：内容图可能在链接内，先于链接导航拦截
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

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
