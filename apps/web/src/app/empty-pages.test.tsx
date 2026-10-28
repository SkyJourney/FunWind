import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SearchPage from "./search/page";
import FollowsPage from "./follows/page";
import ReviewPage from "./admin/review/page";
import AdminPollPage from "./admin/poll/page";

const mocks = vi.hoisted(() => ({
  subject: vi.fn(),
  user: vi.fn(),
  tree: vi.fn(),
  search: vi.fn(),
  feed: vi.fn(),
  moderator: vi.fn(),
  moderated: vi.fn(),
  review: vi.fn(),
  removed: vi.fn(),
  polls: vi.fn(),
}));
vi.mock("@/lib/authz/subject", () => ({ getCurrentSubject: mocks.subject }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/authz/snapshot", () => ({ getForumTree: mocks.tree }));
vi.mock("@/lib/queries/search", () => ({
  cleanQuery: (s: string) => s,
  searchThreads: mocks.search,
}));
vi.mock("@/lib/queries/follows-feed", () => ({ getFollowFeed: mocks.feed }));
vi.mock("@/lib/authz/require-admin", () => ({ requireModerator: mocks.moderator }));
vi.mock("@/lib/authz/service", () => ({ getModeratedForumIds: mocks.moderated }));
vi.mock("@/lib/moderation/review", () => ({
  reviewQueue: mocks.review,
  removedContent: mocks.removed,
}));
vi.mock("@/lib/poll/admin", () => ({ pollAdminList: mocks.polls }));
vi.mock("@/app/actions/posts", () => ({ restorePostAction: vi.fn() }));
vi.mock("./admin/review/actions", () => ({
  approveReviewAction: vi.fn(),
  rejectReviewAction: vi.fn(),
}));
vi.mock("./admin/poll/actions", () => ({ closePollAction: vi.fn(), deletePollAction: vi.fn() }));

describe("页面空态", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.subject.mockResolvedValue({ userId: 1 });
    mocks.user.mockResolvedValue({ id: 1 });
    mocks.tree.mockResolvedValue(new Map());
    mocks.search.mockResolvedValue({ hits: [], total: 0, totalPages: 0 });
    mocks.feed.mockResolvedValue({
      items: [],
      forumCount: 0,
      userCount: 0,
      total: 0,
      page: 1,
      totalPages: 0,
    });
    mocks.moderator.mockResolvedValue(undefined);
    mocks.moderated.mockResolvedValue([904]);
    mocks.review.mockResolvedValue([]);
    mocks.removed.mockResolvedValue([]);
    mocks.polls.mockResolvedValue([]);
  });

  it("搜索无结果保留查询和目录链接", async () => {
    render(await SearchPage({ searchParams: Promise.resolve({ q: "不存在" }) }));
    expect(screen.getByText("没有找到与「不存在」相关的内容。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "板块目录" })).toHaveAttribute("href", "/");
    expect(mocks.search).toHaveBeenCalledWith({ userId: 1 }, "不存在", {
      page: 1,
      sort: "relevance",
    });
  });

  it("关注动态空态保留入口", async () => {
    render(await FollowsPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText("还没有可显示的动态。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "板块页" })).toHaveAttribute("href", "/");
    expect(mocks.feed).toHaveBeenCalledWith({ userId: 1 }, 1, "all");
  });

  it.each([
    ["pending", "所辖板块没有待审核的内容。"],
    ["removed", "所辖板块没有已删除或屏蔽的内容。"],
  ])("审核 %s 空态保留版主作用域", async (tab, text) => {
    render(await ReviewPage({ searchParams: Promise.resolve({ tab }) }));
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(mocks.moderator).toHaveBeenCalledOnce();
    expect(tab === "pending" ? mocks.review : mocks.removed).toHaveBeenCalledWith({ userId: 1 });
  });

  it("投票空态保留版主作用域", async () => {
    render(await AdminPollPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText("没有投票（或你管辖的板块内没有）。")).toBeInTheDocument();
    expect(mocks.moderator).toHaveBeenCalledOnce();
    expect(mocks.polls).toHaveBeenCalledWith({ userId: 1 });
  });
});
