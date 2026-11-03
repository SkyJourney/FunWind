import { Children, isValidElement, type ComponentProps, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ThreadPage, { generateMetadata } from "@/app/t/[tid]/page";
import { PostActionsRow } from "./post-actions-row";
import { AttachmentList } from "./attachment-list";
import type { AttachmentView } from "@/lib/gates/attachments";

const mocks = vi.hoisted(() => ({
  subject: vi.fn(),
  thread: vi.fn(),
  replies: vi.fn(),
  forum: vi.fn(),
  replyAccess: vi.fn(),
  limits: vi.fn(),
  permission: vi.fn(),
  attachments: vi.fn(),
  gates: vi.fn(),
  parents: vi.fn(),
  points: vi.fn(),
  liked: vi.fn(),
  tags: vi.fn(),
  enabled: vi.fn(),
  reviews: vi.fn(),
  delete: vi.fn(),
  hide: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  disable: vi.fn(),
  restore: vi.fn(),
  report: vi.fn(),
}));
vi.mock("@/lib/authz/subject", () => ({ getCurrentSubject: mocks.subject }));
vi.mock("@/lib/queries/threads", () => ({ getCurrentThreadView: mocks.thread }));
vi.mock("@/lib/queries/posts", () => ({ listReplies: mocks.replies }));
vi.mock("@/lib/queries/forums", () => ({ getForumView: mocks.forum }));
vi.mock("@/lib/posting/compose-access", () => ({ loadReplyAccess: mocks.replyAccess }));
vi.mock("@/lib/limits/load", () => ({ limitsFor: mocks.limits }));
vi.mock("@/lib/authz/service", () => ({ checkPermission: mocks.permission }));
vi.mock("@/lib/gates/attachments", () => ({ listAttachments: mocks.attachments }));
vi.mock("@/lib/gates/service", () => ({ loadGateViews: mocks.gates }));
vi.mock("@/lib/queries/locate-post", () => ({ locateParents: mocks.parents, postPath: vi.fn() }));
vi.mock("@/lib/auth/settings", () => ({ getPointsName: mocks.points }));
vi.mock("@/lib/interact/reactions", () => ({ likedPostIds: mocks.liked }));
vi.mock("@/lib/interact/tags", () => ({ tagsOfThreads: mocks.tags }));
vi.mock("@/modules/kernel/state", () => ({ getEnabledModuleIds: mocks.enabled }));
vi.mock("@/lib/moderation/review", () => ({ listContentReviews: mocks.reviews }));
vi.mock("@/app/actions/posts", () => ({
  deletePostAction: mocks.delete,
  hidePostAction: mocks.hide,
  approveContentAction: mocks.approve,
  rejectContentAction: mocks.reject,
  disableContentAction: mocks.disable,
  restorePostAction: mocks.restore,
}));
vi.mock("@/app/actions/reports", () => ({ reportPostAction: mocks.report }));
vi.mock("@/app/actions/replies", () => ({ createReplyAction: vi.fn() }));
vi.mock("@/components/content/post-body", () => ({ PostBody: () => null }));
vi.mock("@/components/content/image-lightbox", () => ({ ImageLightbox: () => null }));
vi.mock("@/components/content/view-beacon", () => ({ ViewBeacon: () => null }));
vi.mock("@/components/interact/like-button", () => ({ LikeButton: () => null }));
vi.mock("@/components/interact/poll-block", () => ({ default: () => null }));
vi.mock("@/components/posting/reply-composer", () => ({ ReplyComposer: () => null }));
vi.mock("@/components/posting/reply-fab", () => ({ ReplyFab: () => null }));

const thread = {
  id: 10,
  forumId: 7,
  authorId: 1,
  state: "visible",
  title: "主题",
  first: { id: 11, bodyMd: "正文", hasGate: false, likeCount: 0 },
  replyCount: 1,
};
const reply = {
  id: 12,
  authorId: 2,
  state: "visible",
  bodyMd: "回帖",
  hasGate: false,
  likeCount: 0,
  floor: 2,
};
const views: AttachmentView[] = [{ status: "locked", postId: 11, gateKey: "g1" }];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.subject.mockResolvedValue({ userId: 1 });
  mocks.thread.mockResolvedValue(thread);
  mocks.replies.mockResolvedValue({ items: [reply], total: 1, page: 1, totalPages: 1 });
  mocks.forum.mockResolvedValue(null);
  mocks.replyAccess.mockResolvedValue({ mode: "closed", text: "不可回复" });
  mocks.limits.mockResolvedValue({ bodyMax: 100 });
  mocks.permission.mockResolvedValue({ allowed: false });
  mocks.attachments.mockResolvedValue(new Map([[11, views]]));
  mocks.gates.mockResolvedValue(new Map());
  mocks.parents.mockResolvedValue(new Map());
  mocks.points.mockResolvedValue("积分");
  mocks.liked.mockResolvedValue(new Set());
  mocks.tags.mockResolvedValue(new Map());
  mocks.enabled.mockResolvedValue(new Set());
  mocks.reviews.mockResolvedValue([]);
});

function propsOf<T>(tree: ReactNode, component: unknown): T[] {
  const out: T[] = [];
  Children.forEach(tree, (node) => {
    if (!isValidElement<{ children?: ReactNode }>(node)) return;
    if (node.type === component) out.push(node.props as T);
    out.push(...propsOf<T>(node.props.children, component));
  });
  return out;
}
const load = () =>
  ThreadPage({ params: Promise.resolve({ tid: "10" }), searchParams: Promise.resolve({}) });

describe("帖子页的展示组件接线", () => {
  it.each([
    [null, false, false, false],
    [1, false, true, false],
    [2, false, false, true],
    [3, false, false, true],
    [3, true, true, true],
  ] as const)(
    "viewer=%s moderator=%s 时权限仍在页面计算，组件仅接收布尔",
    async (userId, moderate, edit, report) => {
      mocks.subject.mockResolvedValue({ userId });
      mocks.permission.mockImplementation(async (_viewer, permission) => ({
        allowed: permission === "forum.moderate" ? moderate : permission === "forum.report",
      }));
      const tree = await load();
      const props = propsOf<ComponentProps<typeof PostActionsRow>>(tree, PostActionsRow);
      // 首帖沿用原 hasPostActions 包裹条件，游客无权限时不渲染空动作行。
      const first = props.find((p) => p.postId === 11);
      if (first)
        expect(first).toMatchObject({
          canEdit: edit,
          canHide: moderate,
          canReview: false,
          canDisable: moderate,
          canRestore: false,
          canReport: report,
          reasonRequired: userId !== 1,
        });
      else expect(userId).toBeNull();
      expect(props.find((p) => p.postId === 12)).toMatchObject({
        canEdit: moderate || userId === 2,
        canReport: userId !== null && userId !== 2,
        reasonRequired: userId !== 2,
      });
      for (const props of propsOf<ComponentProps<typeof AttachmentList>>(tree, AttachmentList))
        expect(props.isGuest).toBe(userId === null);
    },
  );

  it.each(["visible", "pending", "rejected", "hidden", "deleted", "disabled"])(
    "版主的 %s 状态分支与原闭包等价",
    async (state) => {
      mocks.subject.mockResolvedValue({ userId: 3 });
      mocks.thread.mockResolvedValue({ ...thread, state });
      mocks.permission.mockResolvedValue({ allowed: true });
      const first = propsOf<ComponentProps<typeof PostActionsRow>>(
        await load(),
        PostActionsRow,
      ).find((p) => p.postId === 11)!;
      expect(first).toMatchObject({
        canEdit: state !== "deleted",
        canHide: state === "visible",
        canReview: state === "pending",
        canDisable: ["visible", "pending", "rejected"].includes(state),
        canRestore: ["hidden", "deleted"].includes(state),
        canReport: state === "visible",
      });
      expect(first.actions).toEqual({
        delete: mocks.delete,
        hide: mocks.hide,
        approve: mocks.approve,
        reject: mocks.reject,
        disable: mocks.disable,
        restore: mocks.restore,
        report: mocks.report,
      });
    },
  );

  it("附件出口仅执行一次；已有视图按帖原样传入服务端组件，组件不新增查询或鉴权", async () => {
    const tree = await load();
    const props = propsOf<ComponentProps<typeof AttachmentList>>(tree, AttachmentList);
    expect(props).toHaveLength(2);
    expect(props[0]!.attachments).toBe(views);
    expect(props[1]!.attachments).toEqual([]);
    expect(mocks.attachments).toHaveBeenCalledExactlyOnceWith({ userId: 1 }, thread, [
      { id: 11, authorId: 1, hasGate: false },
      { id: 12, authorId: 2, hasGate: false },
    ]);
    const checks = mocks.permission.mock.calls.length;
    for (const entry of props) AttachmentList(entry);
    expect(mocks.permission).toHaveBeenCalledTimes(checks);
    expect(mocks.attachments).toHaveBeenCalledOnce();
  });

  it.each([
    ["01", 1],
    ["+1", 1],
    ["1e2", 100],
    ["0x10", 16],
  ] as const)("主题 metadata 接受旧参数写法 %s", async (tid, expected) => {
    await generateMetadata({ params: Promise.resolve({ tid }), searchParams: Promise.resolve({}) });
    expect(mocks.thread).toHaveBeenCalledWith(expected);
  });
});
