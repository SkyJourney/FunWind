import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { NumberField, parseBounded } from "./number-field";

/** 带状态的外壳：模拟编辑器把 onChange 的值写回 value */
function Harness({
  initial = 0.5,
  onChange,
  min = 0,
  max = 1,
  integer,
  decimals,
  unit,
}: {
  initial?: number;
  onChange?: (value: number) => void;
  min?: number;
  max?: number;
  integer?: boolean;
  decimals?: number;
  unit?: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <NumberField
      label="测试数字"
      value={value}
      min={min}
      max={max}
      integer={integer}
      decimals={decimals}
      unit={unit}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

const box = () => screen.getByRole("textbox", { name: "测试数字" });

describe("parseBounded", () => {
  const unit = { min: 0, max: 1 };

  it.each([
    ["0", 0],
    ["1", 1],
    ["0.5", 0.5],
    ["0.05", 0.05],
    ["0.07", 0.07],
    [".5", 0.5],
    ["0.", 0],
    ["1.", 1],
    ["0.50", 0.5],
    ["  0.5 ", 0.5],
  ])("接受 %j → %d", (text, expected) => {
    expect(parseBounded(text, unit)).toBe(expected);
  });

  it.each([
    "",
    " ",
    "-",
    ".",
    "-.",
    "abc",
    "1e-1",
    "0x1",
    "1,5",
    "--1",
    "+1",
    "0.5.5",
    "1_0",
    "٣", // 阿拉伯-印度数字不是 ASCII 数字
    "1.001", // 小数位超限
    "0.123",
    "1.5", // 超上界
    "-0.01", // 低于下界
    "9".repeat(400), // 超出双精度，Number() 得 Infinity
  ])("拒绝 %j", (text) => {
    expect(parseBounded(text, unit)).toBeNull();
  });

  it("整数规则：拒绝小数；允许末尾的小数点（输入小数的必经中间态）", () => {
    const rule = { min: -64, max: 64, integer: true };
    expect(parseBounded("-64", rule)).toBe(-64);
    expect(parseBounded("64", rule)).toBe(64);
    expect(parseBounded("5.", rule)).toBe(5);
    expect(parseBounded("1.5", rule)).toBeNull();
    expect(parseBounded("0.0", rule)).toBe(0);
    expect(parseBounded("65", rule)).toBeNull();
    expect(parseBounded("-65", rule)).toBeNull();
  });

  it("小数位数跟随 decimals，默认 2 位", () => {
    expect(parseBounded("0.25", { min: 0, max: 16 })).toBe(0.25);
    expect(parseBounded("0.255", { min: 0, max: 16 })).toBeNull();
    expect(parseBounded("0.255", { min: 0, max: 16, decimals: 3 })).toBe(0.255);
    // 1.005 在双精度里是 1.00499999999999989…，按位数判断而不是靠字符串长度
    expect(parseBounded("1.005", { min: 0, max: 16 })).toBeNull();
  });

  it("decimals 为 0 等价于整数，不被当成缺省的 2", () => {
    expect(parseBounded("1.5", { min: 0, max: 10, decimals: 0 })).toBeNull();
    expect(parseBounded("2", { min: 0, max: 10, decimals: 0 })).toBe(2);
  });

  it("上界是无穷时，超出双精度的数字仍被拒绝（不是 Infinity）", () => {
    expect(parseBounded("9".repeat(400), { min: 0, max: Infinity })).toBeNull();
    expect(parseBounded("123456", { min: 0, max: Infinity, integer: true })).toBe(123456);
  });

  it("-0 规范化为 0，不把 -0 带进草稿", () => {
    expect(Object.is(parseBounded("-0", { min: -10, max: 10, integer: true }), 0)).toBe(true);
    expect(Object.is(parseBounded("-0.00", { min: -10, max: 10 }), 0)).toBe(true);
  });
});

describe("NumberField", () => {
  it("显示当前值的规范写法", () => {
    render(<Harness initial={0.25} />);
    expect(box()).toHaveValue("0.25");
    expect(box()).not.toHaveAttribute("aria-invalid");
  });

  it("只在值变化时提交：逐字输入 0.05，中间态 0.0 不被改写成 0", async () => {
    const onChange = vi.fn();
    render(<Harness initial={0.5} onChange={onChange} />);
    await userEvent.clear(box());
    expect(box()).toHaveAttribute("aria-invalid", "true");
    await userEvent.type(box(), "0.05");
    // 0 → 0.（仍是 0，不重复提交）→ 0.0（同上）→ 0.05
    expect(onChange.mock.calls).toEqual([[0], [0.05]]);
    expect(box()).toHaveValue("0.05");
    expect(box()).not.toHaveAttribute("aria-invalid");
  });

  it("没写完或写错的文本不提交，框里保留所输入的内容，并说明范围和当前仍使用的值", () => {
    const onChange = vi.fn();
    render(<Harness initial={0.5} onChange={onChange} />);
    fireEvent.change(box(), { target: { value: "2" } });
    expect(onChange).not.toHaveBeenCalled();
    expect(box()).toHaveValue("2");
    expect(box()).toHaveAttribute("aria-invalid", "true");
    expect(box()).toHaveAccessibleDescription("须为 0 到 1 的数（最多 2 位小数），当前仍使用 0.5");
  });

  it("整数框的提示说的是整数，小数位数跟随 decimals", () => {
    const { unmount } = render(<Harness initial={3} min={-64} max={64} integer />);
    fireEvent.change(box(), { target: { value: "1.5" } });
    expect(box()).toHaveAccessibleDescription("须为 -64 到 64 的整数，当前仍使用 3");
    unmount();
    render(<Harness initial={1} min={0} max={16} decimals={3} />);
    fireEvent.change(box(), { target: { value: "x" } });
    expect(box()).toHaveAccessibleDescription("须为 0 到 16 的数（最多 3 位小数），当前仍使用 1");
  });

  it("decimals 属性同时约束可提交的小数位，不只是改提示文案", () => {
    const onChange = vi.fn();
    render(<Harness initial={1} min={0} max={16} decimals={3} onChange={onChange} />);
    fireEvent.change(box(), { target: { value: "0.125" } });
    expect(onChange).toHaveBeenCalledWith(0.125);
    fireEvent.change(box(), { target: { value: "0.1255" } });
    expect(box()).toHaveAttribute("aria-invalid", "true");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it.each(["", "abc", "1e-1", "0x1", "1,5", "--1", ".", "-", "0.5.5", "2", "-0.1", "0.123", "+1"])(
    "不合法的写法 %j 被拒绝",
    (text) => {
      const onChange = vi.fn();
      render(<Harness onChange={onChange} />);
      // 先把框改成另一个合法写法，保证 change 事件一定触发（受控输入对同值不触发）
      fireEvent.change(box(), { target: { value: "0.25" } });
      onChange.mockClear();
      fireEvent.change(box(), { target: { value: text } });
      expect(box()).toHaveValue(text);
      expect(onChange).not.toHaveBeenCalled();
      expect(box()).toHaveAttribute("aria-invalid", "true");
    },
  );

  it("边界：最小值、最大值提交，刚好越界被拒绝", () => {
    const onChange = vi.fn();
    render(<Harness initial={0} min={-64} max={64} integer onChange={onChange} />);
    fireEvent.change(box(), { target: { value: "64" } });
    fireEvent.change(box(), { target: { value: "-64" } });
    expect(onChange.mock.calls).toEqual([[64], [-64]]);
    onChange.mockClear();
    fireEvent.change(box(), { target: { value: "65" } });
    fireEvent.change(box(), { target: { value: "-65" } });
    expect(onChange).not.toHaveBeenCalled();
    expect(box()).toHaveAttribute("aria-invalid", "true");
  });

  it("首尾空白被去掉（粘贴时常带）", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.change(box(), { target: { value: "  0.75 " } });
    expect(onChange).toHaveBeenCalledWith(0.75);
    // 去掉空白后正好是规范写法，框里就显示规范写法
    expect(box()).toHaveValue("0.75");
  });

  it("-0 以 0 提交", () => {
    const onChange = vi.fn();
    render(<Harness initial={3} min={-10} max={10} integer onChange={onChange} />);
    fireEvent.change(box(), { target: { value: "-0" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(Object.is(onChange.mock.calls[0]![0], 0)).toBe(true);
  });

  it("写错之后改对：错误提示消失", () => {
    render(<Harness />);
    fireEvent.change(box(), { target: { value: "9" } });
    expect(box()).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(box(), { target: { value: "0.8" } });
    expect(box()).not.toHaveAttribute("aria-invalid");
    expect(box()).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByText(/当前仍使用/)).toBeNull();
    expect(box()).toHaveValue("0.8");
  });

  it("合法但不规范的写法（0.50、5.）原样保留，不调用 onChange；值被别处改掉后显示新值", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <NumberField label="测试数字" value={0.5} min={0} max={1} onChange={onChange} />,
    );
    fireEvent.change(box(), { target: { value: "0.50" } });
    expect(box()).toHaveValue("0.50");
    expect(box()).not.toHaveAttribute("aria-invalid");
    expect(onChange).not.toHaveBeenCalled();
    rerender(<NumberField label="测试数字" value={0.7} min={0} max={1} onChange={onChange} />);
    expect(box()).toHaveValue("0.7");
  });

  it("父级换了值：文本框跟着变", () => {
    const { rerender } = render(
      <NumberField label="测试数字" value={0.1} min={0} max={1} onChange={vi.fn()} />,
    );
    expect(box()).toHaveValue("0.1");
    rerender(<NumberField label="测试数字" value={0.9} min={0} max={1} onChange={vi.fn()} />);
    expect(box()).toHaveValue("0.9");
  });

  it("同值重渲染不丢失正在输入的文本；调用方换 key 则丢弃", () => {
    const props = { label: "测试数字", value: 0.1, min: 0, max: 1, onChange: vi.fn() };
    const { rerender } = render(<NumberField {...props} />);
    fireEvent.change(box(), { target: { value: "7" } });
    rerender(<NumberField {...props} />);
    expect(box()).toHaveValue("7");
    rerender(<NumberField key="另一个对象" {...props} />);
    expect(box()).toHaveValue("0.1");
    expect(box()).not.toHaveAttribute("aria-invalid");
  });

  it("没写完的文本原样保留（含首尾空白）", () => {
    render(<Harness />);
    fireEvent.change(box(), { target: { value: " 7 " } });
    expect(box()).toHaveValue(" 7 ");
  });

  it("软键盘类型：可负数用普通键盘（数字键盘没有负号），整数用 numeric，其余 decimal", () => {
    const { unmount } = render(<Harness min={-10} max={10} integer />);
    expect(box()).not.toHaveAttribute("inputmode");
    unmount();
    const second = render(<Harness min={0} max={10} integer initial={1} />);
    expect(box()).toHaveAttribute("inputmode", "numeric");
    second.unmount();
    render(<Harness />);
    expect(box()).toHaveAttribute("inputmode", "decimal");
  });

  it("单位显示在输入框后面；不传则不渲染", () => {
    const { unmount } = render(<Harness unit="px" />);
    expect(screen.getByText("px")).toBeInTheDocument();
    unmount();
    const { container } = render(<Harness />);
    expect(container.textContent).toBe("");
  });

  it("文本框关闭拼写检查与自动补全", () => {
    render(<Harness />);
    expect(box()).toHaveAttribute("spellcheck", "false");
    expect(box()).toHaveAttribute("autocomplete", "off");
  });

  it("同一页面多个输入框同时出错时，各自的提示互不串", () => {
    render(
      <>
        <NumberField label="甲" value={0.1} min={0} max={1} onChange={vi.fn()} />
        <NumberField label="乙" value={0.2} min={0} max={1} onChange={vi.fn()} />
      </>,
    );
    const a = screen.getByRole("textbox", { name: "甲" });
    const b = screen.getByRole("textbox", { name: "乙" });
    fireEvent.change(a, { target: { value: "x" } });
    fireEvent.change(b, { target: { value: "y" } });
    expect(a).toHaveAccessibleDescription(/当前仍使用 0.1/);
    expect(b).toHaveAccessibleDescription(/当前仍使用 0.2/);
  });

  it("在文本框里按回车：不提交所在的表单，也不改动值（对照：同一表单里的普通文本框会提交）", async () => {
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Harness initial={0.25} />
        <input aria-label="对照" />
        <button type="submit">保存</button>
      </form>,
    );
    await userEvent.type(box(), "{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(box()).toHaveValue("0.25");
    await userEvent.type(screen.getByRole("textbox", { name: "对照" }), "{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("没写完的文本按回车：不提交表单，已输入的文本和错误提示都还在", async () => {
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Harness />
        <button type="submit">保存</button>
      </form>,
    );
    await userEvent.clear(box());
    await userEvent.type(box(), "7{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(box()).toHaveValue("7");
    expect(box()).toHaveAttribute("aria-invalid", "true");
  });

  it("testId 落在文本框上，className 落在最外层", () => {
    const { container } = render(
      <NumberField
        label="测试数字"
        value={0.5}
        min={0}
        max={1}
        onChange={vi.fn()}
        testId="my-number"
        className="自定义类"
      />,
    );
    expect(screen.getByTestId("my-number")).toBe(box());
    expect(container.firstElementChild).toHaveClass("自定义类");
  });
});
