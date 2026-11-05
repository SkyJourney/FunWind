import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { blockEnterSubmit } from "./enter-guard";

function mount() {
  render(<input aria-label="框" onKeyDown={blockEnterSubmit} />);
  return screen.getByRole("textbox", { name: "框" });
}

// fireEvent 的返回值：事件没有被 preventDefault 时为 true，被阻止时为 false
describe("blockEnterSubmit", () => {
  it("回车的默认行为被阻止（隐式提交由它触发）", () => {
    expect(fireEvent.keyDown(mount(), { key: "Enter" })).toBe(false);
  });

  it("小键盘回车与带修饰键的回车同样被阻止", () => {
    const input = mount();
    expect(fireEvent.keyDown(input, { key: "Enter", code: "NumpadEnter" })).toBe(false);
    expect(fireEvent.keyDown(input, { key: "Enter", ctrlKey: true })).toBe(false);
    expect(fireEvent.keyDown(input, { key: "Enter", shiftKey: true })).toBe(false);
  });

  it.each(["Tab", "Escape", " ", "a", "1", "#", "Backspace", "ArrowLeft", "Shift"])(
    "其他按键 %j 不受影响",
    (key) => {
      expect(fireEvent.keyDown(mount(), { key })).toBe(true);
    },
  );

  it("按 code 而不是 key 判断的写法不会误认：key 不是 Enter 的事件不拦", () => {
    expect(fireEvent.keyDown(mount(), { key: "a", code: "Enter" })).toBe(true);
  });
});
