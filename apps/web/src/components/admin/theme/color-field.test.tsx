import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ColorField } from "./color-field";

/** 带状态的外壳：模拟编辑器把 onChange 的值写回 value */
function Harness({
  initial = "#ffffff",
  onChange,
}: {
  initial?: string;
  onChange?: (hex: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <ColorField
      label="测试颜色"
      value={value}
      onChange={(hex) => {
        setValue(hex);
        onChange?.(hex);
      }}
    />
  );
}

const box = () => screen.getByRole("textbox", { name: "测试颜色" });
const swatch = () => document.querySelector<HTMLInputElement>('input[type="color"]')!;

describe("ColorField", () => {
  it("文本框与色块都显示当前值", () => {
    render(<Harness initial="#147ba9" />);
    expect(box()).toHaveValue("#147ba9");
    expect(swatch()).toHaveValue("#147ba9");
  });

  it("逐字输入到合法为止才提交一次，值规范化为小写", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.clear(box());
    await userEvent.type(box(), "#ABCDEF");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("#abcdef");
    expect(box()).toHaveValue("#abcdef");
    expect(swatch()).toHaveValue("#abcdef");
    expect(box()).not.toHaveAttribute("aria-invalid");
  });

  it("没写完的文本不提交，框里保留所输入的内容，并说明当前仍使用哪个值", async () => {
    const onChange = vi.fn();
    render(<Harness initial="#ffffff" onChange={onChange} />);
    await userEvent.clear(box());
    await userEvent.type(box(), "#12345");
    expect(onChange).not.toHaveBeenCalled();
    expect(box()).toHaveValue("#12345");
    expect(box()).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/当前仍使用 #ffffff/)).toBeInTheDocument();
    expect(box()).toHaveAccessibleDescription(/当前仍使用 #ffffff/);
    expect(swatch()).toHaveValue("#ffffff");
  });

  it.each(["#abc", "abcdef", "#aabbccdd", "#gggggg", "#12345g", "red", ""])(
    "不合法的写法 %j 被拒绝",
    (text) => {
      const onChange = vi.fn();
      render(<Harness onChange={onChange} />);
      fireEvent.change(box(), { target: { value: text } });
      expect(box()).toHaveValue(text);
      expect(onChange).not.toHaveBeenCalled();
      expect(box()).toHaveAttribute("aria-invalid", "true");
    },
  );

  it("首尾空白被去掉（粘贴时常带）", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.change(box(), { target: { value: "  #AABBCC " } });
    expect(onChange).toHaveBeenCalledWith("#aabbcc");
  });

  it("写错之后改对：错误提示消失", () => {
    render(<Harness />);
    fireEvent.change(box(), { target: { value: "#12" } });
    expect(box()).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(box(), { target: { value: "#123456" } });
    expect(box()).not.toHaveAttribute("aria-invalid");
    expect(box()).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByText(/当前仍使用/)).toBeNull();
    expect(box()).toHaveValue("#123456");
  });

  it("色块选色：提交该值，文本框同步", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.change(swatch(), { target: { value: "#123456" } });
    expect(onChange).toHaveBeenCalledWith("#123456");
    expect(box()).toHaveValue("#123456");
  });

  it("色块选色会清掉没写完的文本", () => {
    render(<Harness />);
    fireEvent.change(box(), { target: { value: "#12" } });
    expect(box()).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(swatch(), { target: { value: "#654321" } });
    expect(box()).not.toHaveAttribute("aria-invalid");
    expect(box()).toHaveValue("#654321");
  });

  it("父级换了值：文本框跟着变", () => {
    const { rerender } = render(<ColorField label="测试颜色" value="#111111" onChange={vi.fn()} />);
    expect(box()).toHaveValue("#111111");
    rerender(<ColorField label="测试颜色" value="#222222" onChange={vi.fn()} />);
    expect(box()).toHaveValue("#222222");
    expect(swatch()).toHaveValue("#222222");
  });

  it("同值重渲染不丢失正在输入的文本；调用方换 key 则丢弃", () => {
    const { rerender } = render(<ColorField label="测试颜色" value="#111111" onChange={vi.fn()} />);
    fireEvent.change(box(), { target: { value: "#12" } });
    rerender(<ColorField label="测试颜色" value="#111111" onChange={vi.fn()} />);
    expect(box()).toHaveValue("#12");
    rerender(<ColorField key="另一个对象" label="测试颜色" value="#111111" onChange={vi.fn()} />);
    expect(box()).toHaveValue("#111111");
    expect(box()).not.toHaveAttribute("aria-invalid");
  });

  it("色块对读屏隐藏且不可聚焦，文本框才是完整的控件", () => {
    render(<Harness />);
    expect(swatch()).toHaveAttribute("aria-hidden", "true");
    expect(swatch()).toHaveAttribute("tabindex", "-1");
    expect(box()).not.toHaveAttribute("aria-hidden");
  });

  it("外层 <label> 点击或定位指向文本框而不是色块", () => {
    render(
      <label>
        外层文字
        <ColorField label="测试颜色" value="#abcdef" onChange={vi.fn()} />
      </label>,
    );
    expect(screen.getByLabelText("外层文字")).toBe(box());
  });

  it("没写完的文本原样保留（含首尾空白），只有提交时才去掉空白", () => {
    render(<Harness />);
    fireEvent.change(box(), { target: { value: "  #12 " } });
    expect(box()).toHaveValue("  #12 ");
  });

  it("文本框关闭拼写检查、自动补全与自动大写（十六进制不是文字）", () => {
    render(<Harness />);
    expect(box()).toHaveAttribute("spellcheck", "false");
    expect(box()).toHaveAttribute("autocomplete", "off");
    expect(box()).toHaveAttribute("autocapitalize", "off");
  });

  it("同一页面多个输入框同时出错时，各自的提示互不串", () => {
    render(
      <>
        <ColorField label="甲" value="#111111" onChange={vi.fn()} />
        <ColorField label="乙" value="#222222" onChange={vi.fn()} />
      </>,
    );
    const a = screen.getByRole("textbox", { name: "甲" });
    const b = screen.getByRole("textbox", { name: "乙" });
    fireEvent.change(a, { target: { value: "#1" } });
    fireEvent.change(b, { target: { value: "#2" } });
    expect(a).toHaveAccessibleDescription(/当前仍使用 #111111/);
    expect(b).toHaveAccessibleDescription(/当前仍使用 #222222/);
  });

  it("testId 落在文本框上，className 落在最外层", () => {
    const { container } = render(
      <ColorField
        label="测试颜色"
        value="#abcdef"
        onChange={vi.fn()}
        testId="my-field"
        className="自定义类"
      />,
    );
    expect(screen.getByTestId("my-field")).toBe(box());
    expect(container.firstElementChild).toHaveClass("自定义类");
  });
});
