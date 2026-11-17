import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AdminDataTable, AdminListPager } from "./admin-list";

describe("AdminListPager 多尺寸/密度控件（M19 S3）", () => {
  it("不传 controls：只渲染计数与分页，与 M9.5 形态一致", () => {
    render(<AdminListPager total={200} page={2} totalPages={5} basePath="/admin/users?q=x" />);
    expect(screen.getByText("共 200 条 · 第 2/5 页")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "下一页" })).toHaveAttribute(
      "href",
      "/admin/users?q=x&page=3",
    );
    expect(screen.queryByLabelText("每页条数")).toBeNull();
    expect(screen.queryByRole("link", { name: "紧凑" })).toBeNull();
  });

  it("传 controls：每页选择器带档位白名单与保留筛选，密度两档链接默认档不进 URL", () => {
    render(
      <AdminListPager
        total={200}
        page={2}
        totalPages={5}
        basePath="/admin/users?q=%E5%A4%9C%E9%9B%A8&size=50&density=compact&status=restricted"
        controls={{
          action: "/admin/users",
          current: { q: "夜雨", status: "restricted" },
          size: 50,
          density: "compact",
        }}
      />,
    );
    // 每页条数：档位白名单 + 当前值
    const size = screen.getByLabelText("每页条数") as HTMLSelectElement;
    expect([...size.options].map((o) => o.value)).toEqual(["10", "20", "50", "100"]);
    expect(size).toHaveValue("50");
    // 每页表单：hidden 域保留当前筛选 + select 自身的 size（不含 page/density）
    const form = size.closest("form") as HTMLFormElement;
    expect(form).toHaveAttribute("action", "/admin/users");
    expect([...new FormData(form).entries()]).toEqual([
      ["q", "夜雨"],
      ["status", "restricted"],
      ["size", "50"],
    ]);
    // 密度链接：当前档高亮且不进自身目标 URL；默认档（cozy）不进 URL
    const compact = screen.getByRole("link", { name: "紧凑" });
    const cozy = screen.getByRole("link", { name: "舒适" });
    expect(compact).toHaveAttribute(
      "href",
      "/admin/users?q=%E5%A4%9C%E9%9B%A8&status=restricted&density=compact",
    );
    expect(cozy).not.toHaveAttribute("href", expect.stringContaining("density"));
    expect(compact).toHaveAttribute("aria-current", "true");
    expect(cozy).not.toHaveAttribute("aria-current");
    // 分页翻页仍由 basePath 透传
    expect(screen.getByRole("link", { name: "下一页" })).toHaveAttribute(
      "href",
      "/admin/users?q=%E5%A4%9C%E9%9B%A8&size=50&density=compact&status=restricted&page=3",
    );
  });
});

describe("AdminDataTable 密度变体（M19 S3）", () => {
  const columns = [{ label: "A", className: "w-10" }];
  const rows = [{ key: 1, cells: [{ cls: "tabular-nums", node: "x" }] }];

  it("缺省 cozy 与原 padding 逐字一致", () => {
    render(<AdminDataTable columns={columns} rows={rows} hasRows />);
    expect(screen.getByRole("cell", { name: "x" })).toHaveClass("px-3", "py-1.5", "tabular-nums");
  });

  it("compact 收紧单元格 padding 且保留列附加类", () => {
    render(<AdminDataTable columns={columns} rows={rows} hasRows density="compact" />);
    expect(screen.getByRole("cell", { name: "x" })).toHaveClass("px-2.5", "py-1", "tabular-nums");
    expect(screen.getByRole("cell", { name: "x" })).not.toHaveClass("px-3");
  });
});
