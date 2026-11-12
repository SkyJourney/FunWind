import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AdminTabs } from "./admin-tabs";
import { AdminFilterBar } from "./admin-filter-bar";

describe("后台展示组件", () => {
  it("页签保留链接顺序、aria 标签、激活样式且不增加 tab 角色", () => {
    render(
      <AdminTabs
        label="举报状态"
        activeKey="pending"
        tabs={[
          { key: "pending", label: "待处理", href: "/admin/reports?forum=7" },
          { key: "resolved", label: "已处置", href: "/admin/reports?forum=7&tab=resolved" },
        ]}
      />,
    );
    const nav = screen.getByRole("navigation", { name: "举报状态" });
    expect(nav).toHaveClass("flex gap-2 text-sm", { exact: true });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((a) => a.getAttribute("href")),
    ).toEqual(["/admin/reports?forum=7", "/admin/reports?forum=7&tab=resolved"]);
    expect(screen.getByText("待处理")).toHaveClass(
      "rounded-full border px-3 py-1 transition-colors bg-primary text-primary-foreground",
      { exact: true },
    );
    expect(screen.getByText("已处置")).toHaveClass("hover:bg-accent");
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.getByText("待处理")).not.toHaveAttribute("aria-current");
  });

  it("筛选壳按原顺序渲染 hidden、控件、筛选、重置与总数", () => {
    const { container } = render(
      <AdminFilterBar
        action="/admin/review"
        method="get"
        hidden={{ tab: "removed", omitted: undefined }}
        resetHref="/admin/review?tab=removed"
        total={<span className="ml-auto text-xs text-muted-foreground">共 9 条</span>}
      >
        <select name="kind" defaultValue="reply" aria-label="按类型筛选">
          <option value="reply">回帖</option>
        </select>
      </AdminFilterBar>,
    );
    const form = container.querySelector("form")!;
    expect(form).toHaveAttribute("method", "get");
    expect(form).toHaveClass(
      "min-w-0",
      "max-w-full",
      "flex",
      "flex-wrap",
      "items-center",
      "gap-2",
      "text-sm",
    );
    expect([...form.children].map((el) => el.tagName)).toEqual(["INPUT", "SELECT", "DIV", "SPAN"]);
    const actions = form.children[2]!;
    expect(actions).toHaveClass("flex-wrap");
    expect(within(actions as HTMLElement).getByRole("button", { name: "筛选" })).toHaveClass(
      "shrink-0",
      "whitespace-nowrap",
    );
    expect([...new FormData(form).entries()]).toEqual([
      ["tab", "removed"],
      ["kind", "reply"],
    ]);
    expect(screen.getByText("重置")).toHaveAttribute("href", "/admin/review?tab=removed");
  });

  it("紧凑筛选保留裸输入与无重置形态；未声明 method 的旧消费者不变", () => {
    const { container } = render(
      <AdminFilterBar
        action="/admin/contents"
        className="flex flex-wrap items-center gap-1.5"
        submitClassName="rounded-lg border px-2.5 py-1 text-xs hover:bg-accent"
      >
        <input name="q" defaultValue="夜雨" />
      </AdminFilterBar>,
    );
    expect(container.querySelector("form")).not.toHaveAttribute("method");
    expect(screen.queryByText("重置")).not.toBeInTheDocument();
    expect(container.querySelector("input")).not.toHaveAttribute("type");
    expect(screen.getByRole("button", { name: "筛选" })).toHaveClass("px-2.5 py-1 text-xs");
  });
});
