import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BASE_COLORS } from "@/lib/theme/token-base";
import { TokenPreview } from "./token-preview";

const box = () => screen.getByTestId("token-preview");
const v = (name: string) => box().style.getPropertyValue(name);

describe("TokenPreview：容器与说明", () => {
  it("说明文字不隐藏、写明是哪一档的草稿；样例对读屏隐藏", () => {
    render(<TokenPreview mode="light" set={undefined} />);
    const caption = screen.getByText(/浅色档草稿，不受后台页面明暗影响/);
    expect(caption.closest('[aria-hidden="true"]')).toBeNull();
    expect(box()).toHaveAttribute("aria-hidden", "true");
  });

  it("深色档的说明与标记", () => {
    render(<TokenPreview mode="dark" set={undefined} />);
    expect(screen.getByText(/深色档草稿/)).toBeInTheDocument();
    expect(box()).toHaveAttribute("data-preview-mode", "dark");
  });

  it("带令牌预览标记属性（semantic.css 里品牌渐变的选择器靠它）", () => {
    render(<TokenPreview mode="light" set={undefined} />);
    expect(box().hasAttribute("data-token-preview")).toBe(true);
    expect(box()).toHaveAttribute("data-preview-mode", "light");
  });

  it("colorScheme 跟着档走（表单控件与滚动条的 UA 样式）", () => {
    const { rerender } = render(<TokenPreview mode="light" set={undefined} />);
    expect(box().style.colorScheme).toBe("light");
    rerender(<TokenPreview mode="dark" set={undefined} />);
    expect(box().style.colorScheme).toBe("dark");
  });
});

describe("TokenPreview：变量写在容器上", () => {
  it("没有覆盖：浅色、深色各用各自的基础层", () => {
    const { rerender } = render(<TokenPreview mode="light" set={undefined} />);
    expect(v("--primary")).toBe(BASE_COLORS.light.primary);
    expect(v("--background")).toBe(BASE_COLORS.light.background);
    expect(v("--shadow-2")).toBe("var(--fw-shadow-2)");
    rerender(<TokenPreview mode="dark" set={undefined} />);
    expect(v("--primary")).toBe(BASE_COLORS.dark.primary);
    expect(v("--background")).toBe(BASE_COLORS.dark.background);
    expect(v("--shadow-2")).toBe("0px 4px 12px 0px rgb(0 0 0 / 0.55)");
  });

  it("草稿覆盖立即生效，去掉后回到基础层", () => {
    const { rerender } = render(
      <TokenPreview mode="light" set={{ colors: { primary: "#ABCDEF" }, radius: "none" }} />,
    );
    expect(v("--primary")).toBe("#abcdef");
    expect(v("--radius")).toBe("0px");
    rerender(<TokenPreview mode="light" set={undefined} />);
    expect(v("--primary")).toBe(BASE_COLORS.light.primary);
    expect(v("--radius")).toBe("var(--fw-radius-lg)");
  });

  it("品牌渐变：没覆盖时容器上没有（交给样式表按公式算），覆盖了才写", () => {
    const { rerender } = render(<TokenPreview mode="light" set={undefined} />);
    expect(v("--gradient-brand")).toBe("");
    rerender(
      <TokenPreview
        mode="light"
        set={{ brandGradient: { angle: 90, from: "#000000", to: "#ffffff" } }}
      />,
    );
    expect(v("--gradient-brand")).toBe("linear-gradient(90deg, #000000 0%, #ffffff 100%)");
  });
});

describe("TokenPreview：样例", () => {
  it("有代表性的控件都在", () => {
    render(<TokenPreview mode="light" set={undefined} />);
    const preview = within(box());
    for (const text of [
      "主按钮",
      "次按钮",
      "强调",
      "危险",
      "描边",
      "提示",
      "错误",
      "成功",
      "警告",
      "次要文字",
      "信息色",
      "Aa 标题",
      "输入框",
      "板块卡",
    ]) {
      expect(preview.getByText(text), text).toBeInTheDocument();
    }
    expect(preview.getAllByText("徽标")).toHaveLength(2);
  });

  it("三档阴影各一个样本，四档圆角各一个样本且用对应的圆角类", () => {
    render(<TokenPreview mode="light" set={undefined} />);
    for (const n of [1, 2, 3]) expect(box().querySelectorAll(`.shadow-${n}`)).toHaveLength(1);
    for (const name of ["sm", "md", "lg", "xl"]) {
      expect(within(box()).getByText(name)).toHaveClass(`rounded-${name}`);
    }
  });

  it("板块卡样例用真实的遮罩类；品牌渐变用在两处", () => {
    render(<TokenPreview mode="light" set={undefined} />);
    expect(box().querySelector(".forum-card-band")).not.toBeNull();
    expect(box().querySelector(".forum-card-band__img")).not.toBeNull();
    expect(box().querySelectorAll('[class*="gradient-brand"]')).toHaveLength(2);
  });

  it("不用 dark: 写法，不放任何可交互元素或共享组件", () => {
    render(<TokenPreview mode="dark" set={undefined} />);
    const all = [box(), ...Array.from(box().querySelectorAll("*"))];
    for (const element of all) expect(element.getAttribute("class") ?? "").not.toMatch(/\bdark:/);
    expect(box().querySelectorAll("button, a, input, select, textarea, [data-slot]")).toHaveLength(
      0,
    );
  });
});
