// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GateReplyLink, GateReveal, GateUnlockButton } from "./gate-reveal";

/**
 * GateReveal 单测（M16.1 Step 4 补齐 M16 残值）：M16 审查报告曾称「失败路径已有单测」，
 * 实际本文件此前不存在。这里把失败→再成功的 stale 标记路径显式钉住：
 * 解锁失败时内容仍是 locked、GateReveal 不渲染，标记留在 sessionStorage；
 * 下次解锁成功渲染 open 内容时才消费并淡入一次（把动画记账到下一次成功，行为按设计无害）。
 */
const flag = (gateId: number) => `fw-gate-reveal:${gateId}`;
const wrapper = () => screen.getByTestId("gate-body").parentElement!;

beforeEach(() => window.sessionStorage.clear());
afterEach(() => {
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("解锁入口打标记", () => {
  it("GateUnlockButton：点击打本 gate 的标记（表单仍走 Server Action，不被拦截）", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <GateUnlockButton gateId={7} disabled={false}>
          免费解锁
        </GateUnlockButton>
      </form>,
    );
    await user.click(screen.getByRole("button", { name: "免费解锁" }));
    expect(window.sessionStorage.getItem(flag(7))).toBe("1");
    expect(onSubmit).toHaveBeenCalled(); // 没有 preventDefault，提交照常
  });

  it("GateReplyLink：点击同样打标记", async () => {
    const user = userEvent.setup();
    render(
      <GateReplyLink gateId={9} href="#reply">
        去回复
      </GateReplyLink>,
    );
    await user.click(screen.getByRole("link", { name: "去回复" }));
    expect(window.sessionStorage.getItem(flag(9))).toBe("1");
  });

  it("disabled 的解锁按钮点不动，也不打标记", async () => {
    const user = userEvent.setup();
    render(
      <GateUnlockButton gateId={7} disabled>
        积分不足
      </GateUnlockButton>,
    );
    await user.click(screen.getByRole("button", { name: "积分不足" }));
    expect(window.sessionStorage.getItem(flag(7))).toBeNull();
  });
});

describe("GateReveal 消费标记", () => {
  it("本会话刚解锁：淡入一次并清掉标记（不重复播）", () => {
    window.sessionStorage.setItem(flag(7), "1");
    const { unmount } = render(
      <GateReveal gateId={7}>
        <span data-testid="gate-body">隐藏内容</span>
      </GateReveal>,
    );
    expect(wrapper().classList.contains("fw-fade-in")).toBe(true);
    expect(window.sessionStorage.getItem(flag(7))).toBeNull();
    unmount();
    // 标记已清：再次渲染（刷新/返回）不重播
    render(
      <GateReveal gateId={7}>
        <span data-testid="gate-body">隐藏内容</span>
      </GateReveal>,
    );
    expect(wrapper().classList.contains("fw-fade-in")).toBe(false);
  });

  it("首次访问已解锁内容（无标记）：不播动画", () => {
    render(
      <GateReveal gateId={7}>
        <span data-testid="gate-body">隐藏内容</span>
      </GateReveal>,
    );
    expect(wrapper().classList.contains("fw-fade-in")).toBe(false);
  });

  it("按 gateId 区分：别的 gate 的标记不被本 gate 消费", () => {
    window.sessionStorage.setItem(flag(99), "1");
    render(
      <GateReveal gateId={7}>
        <span data-testid="gate-body">隐藏内容</span>
      </GateReveal>,
    );
    expect(wrapper().classList.contains("fw-fade-in")).toBe(false);
    expect(window.sessionStorage.getItem(flag(99))).toBe("1"); // 原样留给它自己
  });
});

describe("解锁失败 → 再成功（stale 标记路径）", () => {
  it("失败时不渲染 GateReveal：标记留存、不产生错误动画；下次成功才淡入", async () => {
    const user = userEvent.setup();
    // ① 点解锁 → 打标记
    render(
      <GateUnlockButton gateId={7} disabled={false}>
        免费解锁
      </GateUnlockButton>,
    );
    await user.click(screen.getByRole("button", { name: "免费解锁" }));
    expect(window.sessionStorage.getItem(flag(7))).toBe("1");

    // ② 解锁失败：服务端仍返回 locked，页面渲染的是锁定提示而不是 GateReveal
    render(<p>积分不足，无法解锁</p>);
    expect(screen.queryByTestId("gate-body")).toBeNull();
    expect(window.sessionStorage.getItem(flag(7))).toBe("1"); // stale 标记留着，无害

    // ③ 稍后再次解锁成功：open 内容渲染出来，此时才消费标记并淡入一次
    render(
      <GateReveal gateId={7}>
        <span data-testid="gate-body">隐藏内容</span>
      </GateReveal>,
    );
    expect(wrapper().classList.contains("fw-fade-in")).toBe(true);
    expect(window.sessionStorage.getItem(flag(7))).toBeNull();
  });

  it("失败多次也只淡入一次（标记是布尔，不累积）", async () => {
    const user = userEvent.setup();
    render(
      <GateUnlockButton gateId={7} disabled={false}>
        免费解锁
      </GateUnlockButton>,
    );
    await user.click(screen.getByRole("button", { name: "免费解锁" }));
    await user.click(screen.getByRole("button", { name: "免费解锁" }));
    expect(window.sessionStorage.getItem(flag(7))).toBe("1");
    render(
      <GateReveal gateId={7}>
        <span data-testid="gate-body">隐藏内容</span>
      </GateReveal>,
    );
    expect(wrapper().className).toBe("fw-fade-in"); // 只挂一次，不重复
  });
});

describe("存储不可用时的降级", () => {
  it("sessionStorage 抛异常：打标记不崩、reveal 不播，功能不受影响", async () => {
    const user = userEvent.setup();
    // jsdom 的 Storage 是 Proxy：往实例上写属性会被当成「存一个键」，桩不到方法——必须打原型
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    render(
      <GateUnlockButton gateId={7} disabled={false}>
        免费解锁
      </GateUnlockButton>,
    );
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "免费解锁" }));
    });
    render(
      <GateReveal gateId={7}>
        <span data-testid="gate-body">隐藏内容</span>
      </GateReveal>,
    );
    expect(screen.getByTestId("gate-body")).toBeInTheDocument(); // 内容照常显示
    expect(wrapper().classList.contains("fw-fade-in")).toBe(false);
  });
});
