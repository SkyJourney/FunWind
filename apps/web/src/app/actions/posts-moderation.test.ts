// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { getWebDb } from "@funwind/db";
import { GUEST_SUBJECT } from "@/lib/authz/types";
import { getCurrentSubject } from "@/lib/authz/subject";
import { requireAdmin } from "@/lib/authz/require-admin";
import { approveReview, disableContent, hidePost, rejectReview } from "@/lib/moderation/review";
import {
  approveContentAction,
  disableContentAction,
  hidePostAction,
  rejectContentAction,
} from "./posts";

const mocks = vi.hoisted(() => ({ rows: [{ threadId: 73 }] }));
vi.mock("@/modules", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/net/client-ip", () => ({ clientIpFrom: () => "203.0.113.7" }));
vi.mock("@/lib/auth/session", () => ({ getPasswordChangeUser: async () => null }));
vi.mock("@/lib/authz/require-admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/authz/subject", () => ({ getCurrentSubject: vi.fn() }));
vi.mock("@/lib/posting/mutate", () => ({
  deletePost: vi.fn(),
  editPost: vi.fn(),
  restorePost: vi.fn(),
}));
vi.mock("@/lib/queries/locate-post", () => ({ locatePost: vi.fn(), postPath: vi.fn() }));
vi.mock("@funwind/db", () => ({
  getWebDb: vi.fn(() => ({
    select: () => ({ from: () => ({ where: async () => mocks.rows }) }),
  })),
  posts: { id: "posts.id", threadId: "posts.threadId" },
}));
vi.mock("@/lib/moderation/review", () => ({
  approveReview: vi.fn(),
  disableContent: vi.fn(),
  hidePost: vi.fn(),
  rejectReview: vi.fn(),
}));

const subject = { ...GUEST_SUBJECT, userId: 7 };
const actor = { userId: 7, via: "admin", ip: "203.0.113.7" };
const reason = "  理由 & 再核对  ";
const cases = [
  {
    name: "屏蔽",
    action: hidePostAction,
    service: vi.mocked(hidePost),
    fields: { postId: "57", reason },
    args: [subject, 57, reason, actor],
    success: "/t/73",
    errorPath: null,
    paths: ["/t/73"],
  },
  {
    name: "通过",
    action: approveContentAction,
    service: vi.mocked(approveReview),
    fields: { postId: "57" },
    args: [subject, 57, actor],
    success: "/admin/review?approved=1",
    errorPath: "/admin/review",
    paths: ["/admin/review", "/admin/contents"],
  },
  {
    name: "驳回",
    action: rejectContentAction,
    service: vi.mocked(rejectReview),
    fields: { postId: "57", reason },
    args: [subject, 57, reason, actor],
    success: "/admin/review?rejected=1",
    errorPath: "/admin/contents",
    paths: ["/admin/review", "/admin/contents"],
  },
  {
    name: "封禁",
    action: disableContentAction,
    service: vi.mocked(disableContent),
    fields: { postId: "57", reason },
    args: [subject, 57, reason, actor],
    success: "/admin/contents?disabled=1",
    errorPath: "/admin/contents",
    paths: ["/admin/contents", "/admin/review"],
  },
];

function form(fields: Record<string, string | undefined>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) data.set(key, value);
  }
  return data;
}

function expectRedirect(result: Promise<void>, url: string) {
  return expect(result).rejects.toMatchObject({ digest: `NEXT_REDIRECT;replace;${url};307;` });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rows = [{ threadId: 73 }];
  vi.mocked(getCurrentSubject).mockResolvedValue(subject);
  for (const entry of cases) entry.service.mockResolvedValue({ ok: true });
});

describe.each(cases)("前台公开审核动作：$name", (entry) => {
  it("通过真实 defineAction 解析表单，只委托既有服务，审计来源和回跳刷新保持不变", async () => {
    await expectRedirect(entry.action(form(entry.fields)), entry.success);

    expect(entry.service.mock.calls).toEqual([entry.args]);
    expect(vi.mocked(revalidatePath).mock.calls).toEqual(entry.paths.map((path) => [path]));
    expect(requireAdmin).not.toHaveBeenCalled();
    for (const other of cases) {
      if (other !== entry) expect(other.service).not.toHaveBeenCalled();
    }
  });

  it("游客必须先登录，不调用治理服务或数据库", async () => {
    vi.mocked(getCurrentSubject).mockResolvedValue(GUEST_SUBJECT);
    await expectRedirect(entry.action(form(entry.fields)), "/login");
    expect(entry.service).not.toHaveBeenCalled();
    expect(getWebDb).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each(["forbidden", "not_found", "bad_state", "reason_required", "reason_too_long"] as const)(
    "服务拒绝 %s 时沿用原错误出口，不刷新缓存",
    async (code) => {
      const message = "业务错误：理由 & 作用域";
      entry.service.mockResolvedValue({ ok: false, code, message });
      const result = entry.action(form(entry.fields));
      if (entry.errorPath) {
        await expectRedirect(result, `${entry.errorPath}?error=${encodeURIComponent(message)}`);
      } else {
        await expect(result).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
      }
      expect(entry.service.mock.calls).toEqual([entry.args]);
      expect(revalidatePath).not.toHaveBeenCalled();
      expect(getWebDb).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "0", "-1", "1.5", "bad"])("非法帖子 id %s 在服务前拒绝", async (postId) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(entry.action(form({ ...entry.fields, postId }))).rejects.toMatchObject({
        digest: "NEXT_HTTP_ERROR_FALLBACK;404",
      });
      expect(entry.service).not.toHaveBeenCalled();
      expect(getWebDb).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it("意外服务异常原样抛出，不伪造成功或刷新缓存", async () => {
    const failure = new Error("治理事务失败");
    entry.service.mockRejectedValue(failure);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(entry.action(form(entry.fields))).rejects.toBe(failure);
      expect(revalidatePath).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});

describe("治理输入兼容边界", () => {
  it("屏蔽缺理由仍交给服务做业务校验，失败保持 404", async () => {
    vi.mocked(hidePost).mockResolvedValue({
      ok: false,
      code: "reason_required",
      message: "必须填写理由",
    });
    await expect(hidePostAction(form({ postId: "57" }))).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
    expect(hidePost).toHaveBeenCalledExactlyOnceWith(subject, 57, "", actor);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each(cases.filter((entry) => entry.service !== vi.mocked(approveReview)))(
    "$name 保留 500 字结构校验上限，超限在服务前拒绝",
    async (entry) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await expect(
          entry.action(form({ postId: "57", reason: "字".repeat(501) })),
        ).rejects.toMatchObject({
          digest: "NEXT_HTTP_ERROR_FALLBACK;404",
        });
        expect(entry.service).not.toHaveBeenCalled();
        expect(revalidatePath).not.toHaveBeenCalled();
      } finally {
        error.mockRestore();
      }
    },
  );

  it.each([rejectContentAction, disableContentAction])(
    "驳回和封禁缺理由按结构校验拒绝",
    async (action) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await expect(action(form({ postId: "57" }))).rejects.toMatchObject({
          digest: "NEXT_HTTP_ERROR_FALLBACK;404",
        });
        expect(rejectReview).not.toHaveBeenCalled();
        expect(disableContent).not.toHaveBeenCalled();
        expect(revalidatePath).not.toHaveBeenCalled();
      } finally {
        error.mockRestore();
      }
    },
  );

  it("屏蔽后帖子定位缺失时保留既有 /t/0 兜底", async () => {
    mocks.rows = [];
    await expectRedirect(hidePostAction(form({ postId: "57", reason })), "/t/0");
    expect(revalidatePath).toHaveBeenCalledExactlyOnceWith("/t/0");
  });
});
