import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckinStatus } from "@/lib/checkin/service";
import { checkinModule } from "./index";

const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  status: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/checkin/service", () => ({ getCheckinStatus: mocks.status }));

const unchecked: CheckinStatus = {
  today: "2026-10-31",
  checkedInToday: false,
  streak: 2,
  monthDates: ["2026-10-29", "2026-10-30"],
  totalDays: 12,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user.mockResolvedValue({ id: 42 });
  mocks.status.mockResolvedValue(unchecked);
});

describe.each(["home.after-header", "home.rail"] as const)("签到槽位 %s", (slot) => {
  const renderSlot = checkinModule.slots[slot];

  it("有宿主 Action 时提交实际注入的依赖，状态只读取当前用户", async () => {
    const action = vi.fn(async (_formData: FormData) => {});
    const user = userEvent.setup();
    const { container } = render(await renderSlot({ checkinAction: action }));

    expect(container.querySelectorAll("form")).toHaveLength(1);
    expect(screen.getByText("今日未签到 · 已连签 2 天")).toBeInTheDocument();
    expect(mocks.status).toHaveBeenCalledExactlyOnceWith(42);
    await user.click(screen.getByRole("button", { name: "签到" }));
    expect(action).toHaveBeenCalledExactlyOnceWith(expect.any(FormData));
  });

  it("缺少宿主 Action 时保留状态并明确降级，不输出无 Action 表单", async () => {
    const { container } = render(await renderSlot({}));

    expect(screen.getByRole("status")).toHaveTextContent("签到暂不可用");
    expect(screen.getByText("今日未签到 · 已连签 2 天")).toBeInTheDocument();
    expect(container.querySelector("form")).toBeNull();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(mocks.status).toHaveBeenCalledExactlyOnceWith(42);
  });

  it.each([true, false])(
    "游客（注入=%s）只有登录引导或空侧栏，不读取签到记录",
    async (injected) => {
      mocks.user.mockResolvedValue(null);
      const action = vi.fn(async () => {});
      const node = await renderSlot(injected ? { checkinAction: action } : {});
      const { container } = render(node);

      if (slot === "home.after-header") {
        expect(screen.getByRole("link", { name: "登录后签到" })).toHaveAttribute("href", "/login");
      } else {
        expect(node).toBeNull();
        expect(container).toBeEmptyDOMElement();
      }
      expect(container.querySelector("form")).toBeNull();
      expect(mocks.status).not.toHaveBeenCalled();
      expect(action).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])("已签到（注入=%s）仍展示完成状态，不再提供提交表单", async (injected) => {
    mocks.status.mockResolvedValue({ ...unchecked, checkedInToday: true, streak: 3 });
    const action = vi.fn(async () => {});
    const { container } = render(await renderSlot(injected ? { checkinAction: action } : {}));

    expect(screen.getByText("今日已签到 ✓ 已连签 3 天")).toBeInTheDocument();
    expect(screen.getByText(slot === "home.rail" ? "今日已签到" : "已签到")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(container.querySelector("form")).toBeNull();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(action).not.toHaveBeenCalled();
  });
});
