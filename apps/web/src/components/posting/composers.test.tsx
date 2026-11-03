import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stagedKey } from "@/components/editor/draft";
import { EditComposer } from "./edit-composer";
import { ThreadComposer } from "./thread-composer";

const KEY = "funwind:draft:1:edit:7";
const TITLE_KEY = `${KEY}:title`;
const action = async (_data: FormData) => {};
const currentAttachment = { fileId: 1, name: "现有.zip", sizeBytes: 42, gateKey: null };
const stagedAttachment = { fileId: 2, name: "提交.zip", sizeBytes: 56, gateKey: null };
const editProps: Parameters<typeof EditComposer>[0] = {
  action,
  postId: 7,
  threadKind: "thread",
  title: "最新标题",
  source: "最新正文 **原格式**",
  editedAt: "2026-10-31 08:00:00",
  reasonRequired: false,
  resubmit: false,
  state: "visible",
  reviewNote: null,
  forceSource: null,
  gateUnlocks: [],
  forumId: 3,
  initialAttachments: [currentAttachment],
  initialTags: "字幕,日剧",
  draftKey: KEY,
  restore: false,
  titleMax: 100,
  bodyMax: 10000,
};
const threadProps: Parameters<typeof ThreadComposer>[0] = {
  action,
  forumId: 3,
  draftKey: KEY,
  restore: false,
  titleMax: 100,
  bodyMax: 10000,
};

const hidden = (container: HTMLElement, name: string) =>
  container.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;

afterEach(() => vi.restoreAllMocks());

describe("ThreadComposer：标题草稿回归", () => {
  it("普通进入仅清理旧标题，保持原表单字段、标签与投票结构，输入即保存标题", () => {
    window.localStorage.setItem(TITLE_KEY, "旧标题");
    const { container } = render(<ThreadComposer {...threadProps} />);
    const title = screen.getByRole("textbox", { name: "标题" });
    expect(title).toHaveAttribute("id", "thread-title");
    expect(title).toHaveAttribute("name", "title");
    expect(title).toHaveAttribute("placeholder", "给主题起个名字");
    expect(title).toHaveValue("");
    expect(window.localStorage.getItem(TITLE_KEY)).toBeNull();
    expect(hidden(container, "forumId")).toHaveValue("3");
    expect(hidden(container, "source")).toHaveValue("");
    expect(container.querySelector("form")).toHaveClass("space-y-4");
    expect(container.querySelector("#thread-tags")).toHaveAttribute("name", "tags");
    expect(container.querySelector("#poll-fields")).toHaveClass("hidden", "space-y-2");
    expect(screen.getByRole("button", { name: "发布主题" })).toHaveAttribute("type", "submit");
    fireEvent.input(title, { target: { value: "新主题标题" } });
    expect(window.localStorage.getItem(TITLE_KEY)).toBe("新主题标题");
  });

  it("失败跳回恢复独立标题和提交前暂存正文，标题不改用 :sent 键", async () => {
    window.localStorage.setItem(TITLE_KEY, "提交的标题");
    window.localStorage.setItem(stagedKey(TITLE_KEY), "不应恢复的暂存标题");
    window.localStorage.setItem(stagedKey(KEY), "提交的正文");
    const { container } = render(<ThreadComposer {...threadProps} restore />);
    expect(screen.getByRole("textbox", { name: "标题" })).toHaveValue("提交的标题");
    await waitFor(() => expect(hidden(container, "source")).toHaveValue("提交的正文"));
    expect(window.localStorage.getItem(stagedKey(TITLE_KEY))).toBe("不应恢复的暂存标题");
  });

  it("null 键禁用标题存储，输入仍正常", () => {
    const write = vi.spyOn(Storage.prototype, "setItem");
    render(<ThreadComposer {...threadProps} draftKey={null} restore />);
    fireEvent.input(screen.getByRole("textbox", { name: "标题" }), { target: { value: "不存储" } });
    expect(screen.getByRole("textbox", { name: "标题" })).toHaveValue("不存储");
    expect(write).not.toHaveBeenCalled();
  });

  it("提交只沿用 EditorShell 的正文暂存，不迁移或清除标题键", async () => {
    window.localStorage.setItem(TITLE_KEY, "待提交标题");
    window.localStorage.setItem(KEY, "待提交正文");
    const { container } = render(<ThreadComposer {...threadProps} restore />);
    container.querySelector("form")!.addEventListener("submit", (event) => event.preventDefault());
    fireEvent.submit(container.querySelector("form")!);
    expect(window.localStorage.getItem(TITLE_KEY)).toBe("待提交标题");
    expect(window.localStorage.getItem(stagedKey(TITLE_KEY))).toBeNull();
    await waitFor(() => expect(window.localStorage.getItem(stagedKey(KEY))).toBe("待提交正文"));
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });
});

describe("EditComposer：现有标题与回复", () => {
  it("普通进入保留服务端最新标题和原文，清理标题草稿但保留原表单字段", () => {
    window.localStorage.setItem(TITLE_KEY, "旧标题");
    const { container } = render(<EditComposer {...editProps} reasonRequired />);
    expect(screen.getByRole("textbox", { name: "标题" })).toHaveValue("最新标题");
    expect(screen.getByRole("textbox", { name: "标题" })).toHaveAttribute("id", "edit-title");
    expect(window.localStorage.getItem(TITLE_KEY)).toBeNull();
    expect(hidden(container, "postId")).toHaveValue("7");
    expect(hidden(container, "expectedEditedAt")).toHaveValue(editProps.editedAt!);
    expect(hidden(container, "source")).toHaveValue(editProps.source);
    expect(container.querySelector("#edit-tags")).toHaveValue("字幕,日剧");
    expect(container.querySelector("#edit-reason")).toHaveAttribute("name", "reason");
    expect(screen.getByRole("button", { name: "保存修改" })).toHaveAttribute("type", "submit");
    fireEvent.input(screen.getByRole("textbox", { name: "标题" }), {
      target: { value: "修改标题" },
    });
    expect(window.localStorage.getItem(TITLE_KEY)).toBe("修改标题");
  });

  it.each([null, ""])("restore 无标题草稿或空串时保留原有区别：%j", (saved) => {
    if (saved !== null) window.localStorage.setItem(TITLE_KEY, saved);
    render(<EditComposer {...editProps} restore editedAt={null} />);
    expect(screen.getByRole("textbox", { name: "标题" })).toHaveValue(saved ?? "最新标题");
    expect(document.querySelector('input[name="expectedEditedAt"]')).toHaveValue("");
  });

  it.each([true, false])(
    "编辑回复 restore=%s 不显示标题/标签，也不读取或清理标题草稿",
    (restore) => {
      window.localStorage.setItem(TITLE_KEY, "不得触碰的主题标题");
      const read = vi.spyOn(Storage.prototype, "getItem");
      const remove = vi.spyOn(Storage.prototype, "removeItem");
      const { container } = render(
        <EditComposer {...editProps} threadKind="reply" restore={restore} />,
      );
      expect(screen.queryByRole("textbox", { name: "标题" })).not.toBeInTheDocument();
      expect(container.querySelector("#edit-tags")).toBeNull();
      expect(read).not.toHaveBeenCalledWith(TITLE_KEY);
      expect(remove).not.toHaveBeenCalledWith(TITLE_KEY);
      expect(window.localStorage.getItem(TITLE_KEY)).toBe("不得触碰的主题标题");
    },
  );

  it("编辑 null 草稿键不覆盖服务端标题，不新增草稿写入", () => {
    window.localStorage.setItem(TITLE_KEY, "保留");
    const write = vi.spyOn(Storage.prototype, "setItem");
    render(<EditComposer {...editProps} draftKey={null} restore />);
    expect(screen.getByRole("textbox", { name: "标题" })).toHaveValue("最新标题");
    fireEvent.input(screen.getByRole("textbox", { name: "标题" }), {
      target: { value: "不保存标题" },
    });
    expect(write).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(TITLE_KEY)).toBe("保留");
  });
});

describe("EditComposer：冲突与失败恢复语义", () => {
  it("冲突恢复正文/附件仍需作者选择，不恢复失败标题；接受两份草稿都不改变最新标题", async () => {
    window.localStorage.setItem(TITLE_KEY, "冲突前标题");
    window.localStorage.setItem(stagedKey(KEY), "提交失败的正文");
    window.localStorage.setItem(`${KEY}:attachments:sent`, JSON.stringify([stagedAttachment]));
    const { container } = render(<EditComposer {...editProps} recoverStaged />);
    expect(screen.getByRole("textbox", { name: "标题" })).toHaveValue("最新标题");
    expect(window.localStorage.getItem(TITLE_KEY)).toBeNull();
    expect(hidden(container, "source")).toHaveValue(editProps.source);
    expect(JSON.parse(hidden(container, "attachments").value)).toEqual([
      { fileId: 1, gateKey: null, name: "现有.zip" },
    ]);
    fireEvent.click(await screen.findByRole("button", { name: "恢复草稿" }));
    await waitFor(() => expect(hidden(container, "source")).toHaveValue("提交失败的正文"));
    fireEvent.click(screen.getByRole("button", { name: "恢复附件" }));
    await waitFor(() =>
      expect(JSON.parse(hidden(container, "attachments").value)).toEqual([
        { fileId: 2, gateKey: null, name: "提交.zip" },
      ]),
    );
    expect(screen.getByRole("textbox", { name: "标题" })).toHaveValue("最新标题");
    expect(hidden(container, "expectedEditedAt")).toHaveValue(editProps.editedAt!);
  });

  it("失败恢复仍自动恢复标题和正文，recoverStaged 不改变 restore=true 的标题行为", async () => {
    window.localStorage.setItem(TITLE_KEY, "失败标题");
    window.localStorage.setItem(stagedKey(KEY), "失败正文");
    const { container } = render(<EditComposer {...editProps} restore recoverStaged />);
    expect(screen.getByRole("textbox", { name: "标题" })).toHaveValue("失败标题");
    await waitFor(() => expect(hidden(container, "source")).toHaveValue("失败正文"));
  });

  it("SSR 两个 composer 都不从浏览器存储取得标题，服务端现有标题保持不变", () => {
    window.localStorage.setItem(TITLE_KEY, "本地标题");
    const read = vi.spyOn(Storage.prototype, "getItem");
    const html = renderToString(<EditComposer {...editProps} restore />);
    const threadHtml = renderToString(<ThreadComposer {...threadProps} restore />);
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const threadParsed = new DOMParser().parseFromString(threadHtml, "text/html");
    expect(parsed.querySelector<HTMLInputElement>("#edit-title")!.value).toBe("最新标题");
    expect(threadParsed.querySelector<HTMLInputElement>("#thread-title")!.value).toBe("");
    expect(read).not.toHaveBeenCalled();
  });
});
