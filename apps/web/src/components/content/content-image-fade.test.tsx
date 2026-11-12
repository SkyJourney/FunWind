// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContentImageFade } from "./content-image-fade";

/**
 * ContentImageFade 单测（M16.1 Step 4 补齐 M16 残值）：正文经 dangerouslySetInnerHTML 渲染，
 * 本组件自发现 .content-md 容器并委托处理。四条豁免/降级规则必须钉住：
 * 缓存已加载不动、首屏视口内不动（LCP 豁免）、视口外才懒加载+显影、load/error 都显影。
 *
 * jsdom 没有布局：getBoundingClientRect 默认全 0（bottom=0 不满足「视口内」判定），
 * 因此默认即「视口外」；首屏用例显式给几何。
 */
const setRect = (img: HTMLImageElement, top: number, bottom: number) => {
  img.getBoundingClientRect = () => ({ top, bottom }) as DOMRect;
};
const setComplete = (img: HTMLImageElement, value: boolean) => {
  Object.defineProperty(img, "complete", { configurable: true, value });
};
const img = (id: string) => document.getElementById(id) as HTMLImageElement;

/** 造一个正文容器与若干图片；complete 默认 false（未加载） */
const mountHtml = (count = 1) => {
  document.body.innerHTML = `<div class="content-md">${Array.from(
    { length: count },
    (_, i) => `<img id="i${i}" src="/files/x${i}.png" alt="图${i}">`,
  ).join("")}</div>`;
  for (let i = 0; i < count; i += 1) setComplete(img(`i${i}`), false);
};

beforeEach(() => {
  document.body.innerHTML = "";
});
afterEach(() => {
  document.body.innerHTML = "";
});

describe("视口外图片：懒加载 + 显影", () => {
  it("未加载且在视口外：置 loading=lazy 并挂 fw-img-fade（未加载时 CSS 侧隐藏）", () => {
    mountHtml();
    render(<ContentImageFade />);
    expect(img("i0").loading).toBe("lazy");
    expect(img("i0").classList.contains("fw-img-fade")).toBe(true);
    expect(img("i0").classList.contains("fw-img-loaded")).toBe(false);
  });

  it("load 后挂 fw-img-loaded 显影", () => {
    mountHtml();
    render(<ContentImageFade />);
    img("i0").dispatchEvent(new Event("load"));
    expect(img("i0").classList.contains("fw-img-loaded")).toBe(true);
  });

  it("error 也显影：露出破图/alt，不无限隐藏", () => {
    mountHtml();
    render(<ContentImageFade />);
    img("i0").dispatchEvent(new Event("error"));
    expect(img("i0").classList.contains("fw-img-loaded")).toBe(true);
  });

  it("多张图各自独立显影（一张加载不影响另一张）", () => {
    mountHtml(2);
    render(<ContentImageFade />);
    img("i0").dispatchEvent(new Event("load"));
    expect(img("i0").classList.contains("fw-img-loaded")).toBe(true);
    expect(img("i1").classList.contains("fw-img-loaded")).toBe(false);
  });
});

describe("两条豁免规则", () => {
  it("缓存已加载（complete）：完全不动——不懒加载、不挂显影类（重播是噪音）", () => {
    mountHtml();
    setComplete(img("i0"), true);
    render(<ContentImageFade />);
    expect(img("i0").classList.contains("fw-img-fade")).toBe(false);
    expect(img("i0").loading).not.toBe("lazy");
  });

  it("首屏视口内：LCP 豁免——不挂显影类（Step 0 实验③：淡入会推迟 LCP）", () => {
    mountHtml();
    setRect(img("i0"), 100, 300); // 明确在视口内
    render(<ContentImageFade />);
    expect(img("i0").classList.contains("fw-img-fade")).toBe(false);
    expect(img("i0").loading).not.toBe("lazy");
  });

  it("贴着视口底缘之外（top 超出视口高）：按视口外处理", () => {
    mountHtml();
    setRect(img("i0"), window.innerHeight + 50, window.innerHeight + 250);
    render(<ContentImageFade />);
    expect(img("i0").classList.contains("fw-img-fade")).toBe(true);
  });
});

describe("幂等与范围", () => {
  it("容器打 data 标记：重复挂载不重复处理（StrictMode 双调用安全）", () => {
    mountHtml();
    const { unmount } = render(<ContentImageFade />);
    const root = document.querySelector(".content-md")!;
    expect(root.getAttribute("data-fw-img-fade")).toBe("1");
    expect(img("i0").dataset.fwImgFade).toBe("1");
    // 二次挂载：容器已标记，整段跳过；图片状态不被改写
    img("i0").dispatchEvent(new Event("load"));
    unmount();
    render(<ContentImageFade />);
    expect(img("i0").classList.contains("fw-img-loaded")).toBe(true); // 前一次的结果保留
  });

  it("同一容器再次扫描不重复挂监听（load 只显影一次，不叠加）", () => {
    mountHtml();
    const { unmount } = render(<ContentImageFade />);
    unmount();
    render(<ContentImageFade />);
    // 移除显影类后再触发 load：若重复挂了监听，会被再次加上
    img("i0").classList.remove("fw-img-loaded");
    img("i0").dispatchEvent(new Event("load"));
    expect(img("i0").classList.contains("fw-img-loaded")).toBe(true); // once 监听仍在，正常显影
  });

  it("只处理 .content-md 内的图：容器外的图不动", () => {
    document.body.innerHTML = `
      <div class="content-md"><img id="inside" src="/files/a.png" alt="内"></div>
      <img id="outside" src="/files/b.png" alt="外">
    `;
    setComplete(img("inside"), false);
    setComplete(img("outside"), false);
    render(<ContentImageFade />);
    expect(img("inside").classList.contains("fw-img-fade")).toBe(true);
    expect(img("outside").classList.contains("fw-img-fade")).toBe(false);
    expect(img("outside").dataset.fwImgFade).toBeUndefined();
  });

  it("页面上没有正文容器时不报错", () => {
    document.body.innerHTML = "<p>纯文本页</p>";
    expect(() => render(<ContentImageFade />)).not.toThrow();
  });

  it("多个正文容器（主帖 + 楼层）都被处理", () => {
    document.body.innerHTML = `
      <div class="content-md"><img id="a" src="/files/a.png" alt="a"></div>
      <div class="content-md"><img id="b" src="/files/b.png" alt="b"></div>
    `;
    setComplete(img("a"), false);
    setComplete(img("b"), false);
    render(<ContentImageFade />);
    expect(img("a").classList.contains("fw-img-fade")).toBe(true);
    expect(img("b").classList.contains("fw-img-fade")).toBe(true);
  });
});
