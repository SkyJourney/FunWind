import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ReportsPage from "@/app/admin/reports/page";
import ReviewPage from "@/app/admin/review/page";
import PollPage from "@/app/admin/poll/page";
import ContentsPage from "@/app/admin/contents/page";
import UsersPage from "@/app/admin/users/page";
import InvitesPage from "@/app/admin/invites/page";
import LogsPage from "@/app/admin/logs/page";
import PmPage from "@/app/admin/pm/page";
import AnnouncementsPage from "@/app/admin/announcements/page";
import MailPage from "@/app/admin/mail/page";

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  moderator: vi.fn(),
  user: vi.fn(),
  subject: vi.fn(),
  permission: vi.fn(),
  moderated: vi.fn(),
  reports: vi.fn(),
  review: vi.fn(),
  polls: vi.fn(),
  contents: vi.fn(),
  users: vi.fn(),
  invites: vi.fn(),
  audit: vi.fn(),
  events: vi.fn(),
  pm: vi.fn(),
  stats: vi.fn(),
  mail: vi.fn(),
  summary: vi.fn(),
  chrome: vi.fn(),
  select: vi.fn(),
}));
vi.mock("@/lib/authz/require-admin", () => ({
  requireAdmin: mocks.admin,
  requireModerator: mocks.moderator,
}));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/authz/subject", () => ({ getCurrentSubject: mocks.subject }));
vi.mock("@/lib/authz/service", () => ({
  checkPermission: mocks.permission,
  getModeratedForumIds: mocks.moderated,
}));
vi.mock("@/lib/reports/service", () => ({ listReportPage: mocks.reports }));
vi.mock("@/lib/moderation/review", () => ({ listReviewPage: mocks.review }));
vi.mock("@/lib/poll/admin", () => ({ listPollPage: mocks.polls }));
vi.mock("@/lib/moderation/contents", () => ({ listContentsPage: mocks.contents }));
vi.mock("@/lib/authz/restrictions-admin", () => ({ listAdminUsersPage: mocks.users }));
vi.mock("@/lib/admin/invites", () => ({ listInvitesPage: mocks.invites }));
vi.mock("@/lib/admin/logs", () => ({ queryAuditLogs: mocks.audit, queryEventLogs: mocks.events }));
vi.mock("@/lib/pm/admin", () => ({ listPmMessagesPage: mocks.pm, pmStats: mocks.stats }));
vi.mock("@/lib/chrome/site-chrome", () => ({ getSiteChrome: mocks.chrome }));
vi.mock("@/lib/mail/log-query", async (original) => ({
  ...(await original<typeof import("@/lib/mail/log-query")>()),
  queryEmailLogs: mocks.mail,
  emailLogSummary: mocks.summary,
}));
vi.mock("@funwind/db", async (original) => ({
  ...(await original<typeof import("@funwind/db")>()),
  getWebDb: () => ({ select: mocks.select }),
}));
vi.mock("@/components/admin/forum-select", () => ({
  ForumSelect: ({
    name,
    label,
    defaultValue,
    className,
  }: {
    name: string;
    label: string;
    defaultValue?: number;
    className?: string;
  }) => (
    <select name={name} aria-label={label} defaultValue={defaultValue ?? ""} className={className}>
      <option value="">全部板块</option>
      <option value="7">测试板块</option>
    </select>
  ),
}));
vi.mock("@/components/admin/chrome-rows-editor", () => ({ ChromeRowsEditor: () => null }));
vi.mock("@/components/admin/user-picker", () => ({ UserPicker: () => <input name="q" /> }));
vi.mock("@/app/actions/posts", () => ({ restorePostAction: vi.fn() }));
vi.mock("@/app/admin/reports/actions", () => ({
  dismissReportBulkAction: vi.fn(),
  handleReportAction: vi.fn(),
}));
vi.mock("@/app/admin/review/actions", () => ({
  approveReviewAction: vi.fn(),
  approveReviewBulkAction: vi.fn(),
  rejectReviewAction: vi.fn(),
  rejectReviewBulkAction: vi.fn(),
}));
vi.mock("@/app/admin/poll/actions", () => ({
  closePollAction: vi.fn(),
  deletePollAction: vi.fn(),
  reopenPollAction: vi.fn(),
}));
vi.mock("@/app/admin/contents/actions", () => ({
  approveContentAction: vi.fn(),
  disableContentAction: vi.fn(),
  hideContentAction: vi.fn(),
  rejectContentAction: vi.fn(),
  threadFlagsAction: vi.fn(),
}));
vi.mock("@/app/admin/invites/actions", () => ({
  generateInvitesAction: vi.fn(),
  revokeInviteAction: vi.fn(),
  revokeInviteBatchAction: vi.fn(),
}));
vi.mock("@/app/admin/pm/actions", () => ({ deleteMessageAction: vi.fn() }));
vi.mock("@/app/admin/announcements/actions", () => ({
  createAnnouncementAction: vi.fn(),
  editAnnouncementAction: vi.fn(),
  endAnnouncementAction: vi.fn(),
  saveFooterAction: vi.fn(),
  saveLinksAction: vi.fn(),
  saveNavAction: vi.fn(),
}));

const pages = {
  reports: ReportsPage,
  review: ReviewPage,
  poll: PollPage,
  contents: ContentsPage,
  users: UsersPage,
  invites: InvitesPage,
  logs: LogsPage,
  pm: PmPage,
  announcements: AnnouncementsPage,
  mail: MailPage,
};
type PageName = keyof typeof pages;
const query = { items: [], total: 200, page: 2, totalPages: 5 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.admin.mockResolvedValue(undefined);
  mocks.moderator.mockResolvedValue(undefined);
  mocks.user.mockResolvedValue({ id: 1 });
  mocks.subject.mockResolvedValue({ userId: 1 });
  mocks.permission.mockResolvedValue({ allowed: false });
  mocks.moderated.mockResolvedValue([7]);
  for (const fn of [
    mocks.reports,
    mocks.review,
    mocks.polls,
    mocks.contents,
    mocks.users,
    mocks.invites,
    mocks.audit,
    mocks.events,
    mocks.pm,
    mocks.mail,
  ])
    fn.mockResolvedValue(query);
  mocks.stats.mockResolvedValue({ conversations: 0, messages: 0, today: 0 });
  mocks.summary.mockResolvedValue({ sent: 0, failed: 0 });
  mocks.chrome.mockResolvedValue({ nav: [], links: [], footerText: "" });
  mocks.select.mockImplementation((fields?: object) =>
    fields
      ? { from: () => ({ where: async () => [{ n: 200 }] }) }
      : {
          from: () => ({
            where: () => ({ orderBy: () => ({ limit: () => ({ offset: async () => [] }) }) }),
          }),
        },
  );
});

async function show(name: PageName, sp: Record<string, string> = {}) {
  return render(await pages[name]({ searchParams: Promise.resolve(sp) }));
}

function navLinks(label: string) {
  return within(screen.getByRole("navigation", { name: label }))
    .getAllByRole("link")
    .map((a) => [a.textContent, a.getAttribute("href")]);
}

describe("最高重复四页的 URL 与筛选 DOM 快照", () => {
  it("举报默认 tab 的新增键跟在 forum 后；切换/重置/分页/flash 不带旧页码", async () => {
    const { container } = await show("reports", { forum: "7", page: "2", error: "错误" });
    expect(navLinks("举报状态")).toMatchInlineSnapshot(`
      [
        [
          "待处理",
          "/admin/reports?forum=7",
        ],
        [
          "已处置",
          "/admin/reports?forum=7&tab=resolved",
        ],
        [
          "已忽略",
          "/admin/reports?forum=7&tab=dismissed",
        ],
      ]
    `);
    expect(screen.getByRole("link", { name: "重置" })).toHaveAttribute("href", "/admin/reports");
    expect(screen.getByRole("link", { name: "关闭提示" })).toHaveAttribute(
      "href",
      "/admin/reports?forum=7",
    );
    expect(screen.getByRole("link", { name: "上一页" })).toHaveAttribute(
      "href",
      "/admin/reports?forum=7&page=1",
    );
    const form = container.querySelector('form[action="/admin/reports"]')!;
    expect(form).toHaveClass(
      "min-w-0",
      "max-w-full",
      "flex",
      "flex-wrap",
      "items-center",
      "gap-2",
      "text-sm",
    );
    expect([...new FormData(form as HTMLFormElement).entries()]).toEqual([["forum", "7"]]);
    expect(screen.getByText("该状态下没有举报。")).toBeInTheDocument();
  });

  it("审核 removed 页签、类型、权限作用域和原筛选顺序保持", async () => {
    const { container } = await show("review", {
      tab: "removed",
      forum: "7",
      kind: "reply",
      page: "2",
    });
    expect(navLinks("审核视图")).toMatchInlineSnapshot(`
      [
        [
          "待审核",
          "/admin/review?forum=7&kind=reply",
        ],
        [
          "已删隐内容",
          "/admin/review?tab=removed&forum=7&kind=reply",
        ],
      ]
    `);
    const form = container.querySelector('form[action="/admin/review"]') as HTMLFormElement;
    expect([...new FormData(form).entries()]).toEqual([
      ["tab", "removed"],
      ["forum", "7"],
      ["kind", "reply"],
    ]);
    expect(screen.getByRole("link", { name: "重置" })).toHaveAttribute(
      "href",
      "/admin/review?tab=removed",
    );
    expect(screen.getByRole("link", { name: "下一页" })).toHaveAttribute(
      "href",
      "/admin/review?tab=removed&forum=7&kind=reply&page=3",
    );
    expect(mocks.review).toHaveBeenCalledWith(
      { userId: 1 },
      { tab: "removed", forumId: 7, kind: "reply", page: 2 },
    );
    expect(screen.getByText("所辖板块没有已删除或屏蔽的内容。")).toBeInTheDocument();
  });

  it("投票已截止页保留 tab、板块、重置、计数和版主作用域", async () => {
    const { container } = await show("poll", { tab: "closed", forum: "7", page: "2" });
    expect(navLinks("投票状态")).toMatchInlineSnapshot(`
      [
        [
          "全部",
          "/admin/poll?forum=7",
        ],
        [
          "进行中",
          "/admin/poll?tab=open&forum=7",
        ],
        [
          "已截止",
          "/admin/poll?tab=closed&forum=7",
        ],
      ]
    `);
    const form = container.querySelector('form[action="/admin/poll"]') as HTMLFormElement;
    expect([...new FormData(form).entries()]).toEqual([
      ["tab", "closed"],
      ["forum", "7"],
    ]);
    expect(form.lastElementChild).toHaveTextContent("共 200 个");
    expect(screen.getByRole("link", { name: "重置" })).toHaveAttribute(
      "href",
      "/admin/poll?tab=closed",
    );
    expect(screen.getByRole("link", { name: "下一页" })).toHaveAttribute(
      "href",
      "/admin/poll?tab=closed&forum=7&page=3",
    );
    expect(mocks.polls).toHaveBeenCalledWith({
      status: "closed",
      forumId: 7,
      page: 2,
      moderated: [7],
    });
  });

  it("内容类型从默认值切换时 kind 追加在原筛项之后，紧凑 DOM 不增加重置", async () => {
    const { container } = await show("contents", {
      q: "夜 雨",
      forum: "7",
      state: "hidden",
      page: "2",
    });
    expect(navLinks("内容类型")).toMatchInlineSnapshot(`
      [
        [
          " 主题",
          "/admin/contents?q=%E5%A4%9C+%E9%9B%A8&forum=7&state=hidden",
        ],
        [
          " 回帖",
          "/admin/contents?q=%E5%A4%9C+%E9%9B%A8&forum=7&state=hidden&kind=reply",
        ],
      ]
    `);
    expect(navLinks("内容状态")[0]).toEqual([
      "全部",
      "/admin/contents?q=%E5%A4%9C+%E9%9B%A8&forum=7",
    ]);
    expect(screen.getByRole("link", { name: "下一页" })).toHaveAttribute(
      "href",
      "/admin/contents?q=%E5%A4%9C+%E9%9B%A8&forum=7&state=hidden&page=3",
    );
    const form = container.querySelector('form[action="/admin/contents"]') as HTMLFormElement;
    expect(form).toHaveClass(
      "min-w-0",
      "max-w-full",
      "flex",
      "flex-wrap",
      "items-center",
      "gap-1.5",
    );
    expect([...new FormData(form).entries()]).toEqual([
      ["state", "hidden"],
      ["forum", "7"],
      ["q", "夜 雨"],
    ]);
    expect(form.querySelector('[name="q"]')).not.toHaveAttribute("type");
    expect(screen.queryByRole("link", { name: "重置" })).not.toBeInTheDocument();
    expect(mocks.contents).toHaveBeenCalledWith({
      kind: "thread",
      q: "夜 雨",
      forumId: 7,
      state: "hidden",
      page: 2,
      scopeForumIds: [7],
    });
  });
});

describe("其余页面 query/page 的兼容性", () => {
  it.each([
    [
      "users",
      {
        q: "夜 雨",
        status: "restricted",
        lifecycle: "all",
        credential: "no_password",
        sort: "id",
        page: "2",
      },
      "/admin/users?q=%E5%A4%9C+%E9%9B%A8&status=restricted&lifecycle=all&credential=no_password&sort=id&page=3",
    ],
    [
      "invites",
      { status: "available", batch: "春 季", page: "2" },
      "/admin/invites?status=available&batch=%E6%98%A5+%E5%AD%A3&page=3",
    ],
    ["pm", { q: "夜 雨", page: "2" }, "/admin/pm?q=%E5%A4%9C+%E9%9B%A8&page=3"],
    ["announcements", { status: "ended", page: "2" }, "/admin/announcements?status=ended&page=3"],
    [
      "mail",
      { status: "failed", kind: "notice", q: "  夜 雨  ", scene: "reply", page: "2" },
      "/admin/mail?status=failed&kind=notice&q=%E5%A4%9C+%E9%9B%A8&page=3",
    ],
  ] as const)("%s 分页保留原筛选顺序与省略策略", async (name, sp, expected) => {
    await show(name, sp);
    expect(screen.getByRole("link", { name: "下一页" })).toHaveAttribute("href", expected);
  });

  it("日志分页保留筛选且只产生一个 page 参数", async () => {
    await show("logs", { action: "thread created", actor: "7", page: "2" });
    expect(screen.getByRole("link", { name: "下一页" })).toHaveAttribute(
      "href",
      "/admin/logs?tab=audit&action=thread+created&actor=7&page=3",
    );
    expect(navLinks("日志类型")).toEqual([
      ["审计日志", "/admin/logs"],
      ["事件日志", "/admin/logs?tab=events"],
    ]);
  });

  it.each(Object.keys(pages) as PageName[])("%s 第一个异步边界仍是入口鉴权", async (name) => {
    const order: string[] = [];
    for (const fn of [mocks.admin, mocks.moderator, mocks.user])
      fn.mockImplementation(async () => {
        order.push("auth");
        return { id: 1 };
      });
    const searchParams = {
      then(resolve: (value: Record<string, string>) => void) {
        order.push("params");
        resolve({});
      },
    } as Promise<Record<string, string>>;
    await pages[name]({ searchParams });
    expect(order[0]).toBe("auth");
    expect(order.indexOf("params")).toBeGreaterThan(0);
  });

  it.each(["reports", "review", "poll", "contents", "users", "invites", "logs", "pm"] as const)(
    "%s 旧列表仍将非整数/Infinity 原值交给分页服务",
    async (name) => {
      const service = {
        reports: mocks.reports,
        review: mocks.review,
        poll: mocks.polls,
        contents: mocks.contents,
        users: mocks.users,
        invites: mocks.invites,
        logs: mocks.audit,
        pm: mocks.pm,
      }[name];
      for (const raw of ["2.9", "-3", "Infinity", "NaN"]) {
        await pages[name]({ searchParams: Promise.resolve({ page: raw }) });
        const args = service.mock.lastCall!;
        const actual = name === "review" || name === "users" ? args[1] : args[0];
        expect(typeof actual === "number" ? actual : actual.page).toBe(Number(raw) || 1);
      }
    },
  );

  it.each(["2.9", "-3", "Infinity", "NaN"])("邮件仍拒绝 %s 页码而非取整", async (page) => {
    await MailPage({ searchParams: Promise.resolve({ page }) });
    expect(mocks.mail).toHaveBeenCalledWith(expect.objectContaining({ page: 1 }));
  });
});
