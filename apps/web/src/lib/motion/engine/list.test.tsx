// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MOTION_DEFAULTS } from "./config";
import { MotionList } from "./list";

/** 渲染 n 个带 key 的条目，返回容器内直接子元素 */
function renderList(
  n: number,
  props: Omit<React.ComponentProps<typeof MotionList>, "children"> = {},
) {
  const { container } = render(
    <MotionList {...props}>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} data-testid={`item-${i}`} className="base" style={{ color: "red" }}>
          {i}
        </div>
      ))}
    </MotionList>,
  );
  return Array.from(container.querySelectorAll<HTMLElement>("[data-testid]"));
}

describe("MotionList · list.enter 首屏错落", () => {
  it("前 maxStaggerItems 项挂 fw-enter，延迟按令牌步长计算（不裸写 ms）", () => {
    const items = renderList(12);
    const cap = MOTION_DEFAULTS.maxStaggerItems;
    items.forEach((el, i) => {
      if (i < cap) {
        expect(el.className).toContain("fw-enter");
        expect(el.getAttribute("style")).toContain(`calc(var(--fw-stagger-step) * ${i})`);
        expect(el.getAttribute("style")).not.toMatch(/\d+ms/);
      } else {
        expect(el.className).not.toContain("fw-enter");
        expect(el.getAttribute("style")).not.toContain("animation-delay");
      }
    });
  });

  it("合并保留条目原有 className 与 style，不新增包裹盒子", () => {
    const items = renderList(3);
    expect(items[0]!.className).toBe("base fw-enter");
    expect(items[0]!.getAttribute("style")).toContain("color: red");
    // 直接子元素就是条目本身（无额外包装层）
    expect(items[0]!.parentElement?.querySelectorAll("[data-testid]").length).toBe(3);
  });

  it("animate=false 原样渲染：不挂类也不写延迟（翻页 / 直达深页不重播）", () => {
    const items = renderList(5, { animate: false });
    items.forEach((el) => {
      expect(el.className).toBe("base");
      expect(el.getAttribute("style")).not.toContain("animation-delay");
    });
  });

  it("保留条目 key：重渲染不产生重复挂载（key  warning 兜底）", () => {
    const { container, rerender } = render(
      <MotionList>
        <div key="a" data-testid="a">
          a
        </div>
        <div key="b" data-testid="b">
          b
        </div>
      </MotionList>,
    );
    const first = container.querySelector('[data-testid="a"]');
    rerender(
      <MotionList>
        <div key="a" data-testid="a">
          a2
        </div>
        <div key="b" data-testid="b">
          b2
        </div>
      </MotionList>,
    );
    expect(container.querySelector('[data-testid="a"]')).toBe(first);
  });

  it("非元素子节点（文本 / null）原样透传，不报错", () => {
    const { container } = render(
      <MotionList>
        纯文本
        {null}
        <div key="x" data-testid="x">
          x
        </div>
      </MotionList>,
    );
    expect(container.textContent).toContain("纯文本");
    expect(container.querySelector('[data-testid="x"]')?.className).toContain("fw-enter");
  });
});

describe("MotionList · list.append 追加淡入", () => {
  it("每项挂 fw-fade-in，无延迟无封顶", () => {
    const items = renderList(15, { preset: "list.append" });
    items.forEach((el) => {
      expect(el.className).toContain("fw-fade-in");
      expect(el.className).not.toContain("fw-enter");
      expect(el.getAttribute("style")).not.toContain("animation-delay");
    });
  });

  it("animate=false 时追加项也不挂类", () => {
    const items = renderList(3, { preset: "list.append", animate: false });
    items.forEach((el) => expect(el.className).toBe("base"));
  });
});
