import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { getForumTree } from "@/lib/authz/snapshot";
import { getCurrentSubject } from "@/lib/authz/subject";
import { checkPermission, getModeratedForumIds } from "@/lib/authz/service";
import { ForumSelect } from "./forum-select";

vi.mock("@/lib/authz/snapshot", () => ({ getForumTree: vi.fn() }));
vi.mock("@/lib/authz/subject", () => ({ getCurrentSubject: vi.fn() }));
vi.mock("@/lib/authz/service", () => ({
  checkPermission: vi.fn(),
  getModeratedForumIds: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getForumTree).mockResolvedValue({
    all: () => [
      { id: 1, depth: 1, kind: "section", name: "公共分区" },
      { id: 2, depth: 2, kind: "forum", name: "所辖板块" },
      { id: 3, depth: 2, kind: "forum", name: "不可读的秘密板块" },
    ],
  } as Awaited<ReturnType<typeof getForumTree>>);
  vi.mocked(getCurrentSubject).mockResolvedValue({ userId: 42 } as Awaited<
    ReturnType<typeof getCurrentSubject>
  >);
  vi.mocked(checkPermission).mockResolvedValue({ allowed: false, reason: "无站长权限" });
  vi.mocked(getModeratedForumIds).mockResolvedValue([2]);
});

const props = { name: "forum", label: "按板块筛选", allLabel: "全部板块" };

describe("后台板块选择器", () => {
  it("版主只收到所辖板块，不下发其他受限板块的名称和 id", async () => {
    render(await ForumSelect(props));
    expect(screen.getByRole("option", { name: "所辖板块" })).toHaveValue("2");
    expect(screen.queryByRole("option", { name: "不可读的秘密板块" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "公共分区" })).not.toBeInTheDocument();
  });

  it("站长仍保留全树且支持只列普通板块", async () => {
    vi.mocked(checkPermission).mockResolvedValue({ allowed: true, reason: "站长" });
    render(await ForumSelect({ ...props, kindFilter: "forum" }));
    expect(screen.getByRole("option", { name: "不可读的秘密板块" })).toHaveValue("3");
    expect(screen.queryByRole("option", { name: "公共分区" })).not.toBeInTheDocument();
  });

  it("没有版主作用域时只有空选项，不能因空集合回退全树", async () => {
    vi.mocked(getModeratedForumIds).mockResolvedValue([]);
    render(await ForumSelect(props));
    expect(screen.getAllByRole("option")).toHaveLength(1);
  });

  it("调用方类名与默认边框、宽度防溢出基线合并，而非整体覆盖", async () => {
    render(await ForumSelect({ ...props, className: "text-xs w-44" }));
    const select = screen.getByRole("combobox");
    expect(select).toHaveClass("min-w-0", "max-w-full", "border", "text-xs", "w-44");
  });
});
