// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentPanel, type AttachmentItem } from "./attachment-panel";

const KEY = "funwind:draft:1:edit:9";
const hidden = (c: HTMLElement) => c.querySelector<HTMLInputElement>('input[name="attachments"]')!;
const fileInput = () =>
  document.querySelector<HTMLInputElement>('input[type="file"][aria-label="选择附件"]')!;
const parsed = (c: HTMLElement) =>
  JSON.parse(hidden(c).value) as { fileId: number; gateKey: string | null; name: string }[];

const item = (fileId: number, name: string, gateKey: string | null = null): AttachmentItem => ({
  fileId,
  name,
  sizeBytes: 2048,
  gateKey,
});

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

/** 附件列表默认折叠（M10.8 Step 9）：点击「附件（N）」展开 */
const toggle = () => screen.getByRole("button", { name: /^附件（\d+）$/ });

/** 渲染并展开列表（大多数用例关心的是列表里的行） */
function mount(props: Partial<Parameters<typeof AttachmentPanel>[0]> = {}) {
  const r = mountCollapsed(props);
  // 从暂存恢复时列表已自动展开：只在折叠时才点
  if (toggle().getAttribute("aria-expanded") === "false") fireEvent.click(toggle());
  return r;
}

function mountCollapsed(props: Partial<Parameters<typeof AttachmentPanel>[0]> = {}) {
  return render(
    <AttachmentPanel
      forumId={901}
      gateKeys={["g1", "g2"]}
      initial={[item(1, "字幕包.zip"), item(2, "花絮.rar", "g1")]}
      draftKey={null}
      restoreDraft={false}
      {...props}
    />,
  );
}

describe("AttachmentPanel：折叠（M10.8 Step 9）", () => {
  it("默认折叠成「附件（N）」一行：列表不显示，但提交用的隐藏字段仍带着全部附件", () => {
    const { container } = mountCollapsed();
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(toggle()).toHaveTextContent("附件（2）");
    expect(screen.queryByTestId("attachment-row")).toBeNull();
    expect(parsed(container)).toHaveLength(2);
  });

  it("点击展开 / 再点收起", () => {
    mountCollapsed();
    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByTestId("attachment-row")).toHaveLength(2);
    fireEvent.click(toggle());
    expect(screen.queryByTestId("attachment-row")).toBeNull();
  });
});

describe("AttachmentPanel：恢复后展开（M10.8 Step 9）", () => {
  it("从提交前的暂存恢复列表后，列表自动展开（作者看到恢复的结果）", () => {
    window.localStorage.setItem(`${KEY}:attachments:sent`, JSON.stringify([item(7, "恢复的.zip")]));
    mountCollapsed({ draftKey: KEY, restoreDraft: true });
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("恢复的.zip")).toBeInTheDocument();
  });
});

describe("AttachmentPanel", () => {
  it("展示现有附件与归属，隐藏字段为 JSON", () => {
    const { container } = mount();
    expect(screen.getByText("字幕包.zip")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "附件归属：花絮.rar" })).toHaveValue("g1");
    expect(parsed(container)).toEqual([
      { fileId: 1, gateKey: null, name: "字幕包.zip" },
      { fileId: 2, gateKey: "g1", name: "花絮.rar" },
    ]);
  });

  it("切换归属：隐藏字段写入门控 key，选回公开则为 null", async () => {
    const user = userEvent.setup();
    const { container } = mount();
    await user.selectOptions(screen.getByRole("combobox", { name: "附件归属：字幕包.zip" }), "g2");
    expect(parsed(container)[0]).toMatchObject({ fileId: 1, gateKey: "g2" });
    await user.selectOptions(screen.getByRole("combobox", { name: "附件归属：字幕包.zip" }), "");
    expect(parsed(container)[0]).toMatchObject({ fileId: 1, gateKey: null });
  });

  it("门控已不存在：提示，并以公开保存（不改写界面状态）", () => {
    const { container } = mount({ gateKeys: ["g2"] });
    expect(screen.getByText("锁定内容已不存在，将保存为公开")).toBeInTheDocument();
    expect(parsed(container)[1]).toMatchObject({ fileId: 2, gateKey: null });
  });

  it("移除附件：列表与隐藏字段同步减少", async () => {
    const user = userEvent.setup();
    const { container } = mount();
    await user.click(screen.getByRole("button", { name: "移除附件：字幕包.zip" }));
    expect(screen.queryByText("字幕包.zip")).toBeNull();
    expect(parsed(container).map((x) => x.fileId)).toEqual([2]);
  });

  it("上传成功：追加一行，附件以 purpose=attachment 与版块提交", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            fileId: 7,
            sizeBytes: 9,
            storageKey: "k",
            url: "/files/k",
            mime: "application/zip",
            width: null,
            height: null,
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = mount({ initial: [] });
    await user.upload(fileInput(), new File(["zip"], "新附件.zip", { type: "application/zip" }));
    await waitFor(() => expect(screen.getByText("新附件.zip")).toBeInTheDocument());
    expect(parsed(container)).toEqual([{ fileId: 7, gateKey: null, name: "新附件.zip" }]);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("/api/upload?purpose=attachment&forumId=901");
  });

  it("上传失败：展示服务端给出的中文原因，列表不变", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "quota_exceeded" }), { status: 429 })),
    );
    const user = userEvent.setup();
    mount({ initial: [] });
    await user.upload(fileInput(), new File(["x"], "a.zip", { type: "application/zip" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("今天的上传次数已用完");
    expect(screen.queryByText("a.zip")).toBeNull();
  });

  it("上限 20 个：超过时直接提示，不发起上传", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const full = Array.from({ length: 20 }, (_, i) => item(100 + i, `f${i}.zip`));
    mount({ initial: full });
    await user.upload(fileInput(), new File(["x"], "more.zip", { type: "application/zip" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("最多 20 个附件");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("草稿：列表随编辑写入 :attachments 键；清空后键存空数组（冲突恢复可表达「全部移除」）", async () => {
    const user = userEvent.setup();
    mount({ draftKey: KEY, initial: [] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ fileId: 5, sizeBytes: 1 }), { status: 200 })),
    );
    await user.upload(fileInput(), new File(["x"], "d.zip", { type: "application/zip" }));
    await screen.findByText("d.zip");
    expect(JSON.parse(window.localStorage.getItem(`${KEY}:attachments`)!)).toEqual([
      expect.objectContaining({ fileId: 5, name: "d.zip" }),
    ]);
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "移除附件：d.zip" }));
    });
    expect(JSON.parse(window.localStorage.getItem(`${KEY}:attachments`)!)).toEqual([]);
  });

  it("失败跳回：从提交前的暂存恢复列表", async () => {
    window.localStorage.setItem(`${KEY}:attachments:sent`, JSON.stringify([item(9, "暂存.zip")]));
    mount({ draftKey: KEY, restoreDraft: true, initial: [] });
    expect(await screen.findByText("暂存.zip")).toBeInTheDocument();
  });
});

describe("AttachmentPanel：编辑冲突后的附件恢复", () => {
  const STAGED = `${KEY}:attachments:sent`;
  const submitted = JSON.stringify([item(9, "我提交的.zip")]);

  it("冲突跳回且暂存列表与服务端不同：提示恢复或丢弃；未处理前不替换服务端列表", async () => {
    window.localStorage.setItem(STAGED, submitted);
    const { container } = mount({ draftKey: KEY, restoreDraft: false, recoverStaged: true });
    expect(await screen.findByRole("status")).toHaveTextContent("发现一份未保存的附件修改");
    expect(parsed(container).map((x) => x.fileId)).toEqual([1, 2]);
  });

  it("选择恢复：列表换成作者提交的那一版", async () => {
    window.localStorage.setItem(STAGED, submitted);
    const user = userEvent.setup();
    const { container } = mount({ draftKey: KEY, restoreDraft: false, recoverStaged: true });
    await user.click(await screen.findByRole("button", { name: "恢复附件" }));
    await waitFor(() => expect(parsed(container).map((x) => x.fileId)).toEqual([9]));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("选择丢弃：暂存键删除，列表保持服务端版本", async () => {
    window.localStorage.setItem(STAGED, submitted);
    const user = userEvent.setup();
    const { container } = mount({ draftKey: KEY, restoreDraft: false, recoverStaged: true });
    await user.click(await screen.findByRole("button", { name: "丢弃" }));
    expect(window.localStorage.getItem(STAGED)).toBeNull();
    expect(parsed(container).map((x) => x.fileId)).toEqual([1, 2]);
  });

  it("暂存列表与服务端相同：不提示", async () => {
    window.localStorage.setItem(
      STAGED,
      JSON.stringify([item(1, "字幕包.zip"), item(2, "花絮.rar", "g1")]),
    );
    mount({ draftKey: KEY, restoreDraft: false, recoverStaged: true });
    await act(async () => {});
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("普通进入：过期的暂存键被清理，不会在之后的页面里重新出现", async () => {
    window.localStorage.setItem(STAGED, submitted);
    mount({ draftKey: KEY, restoreDraft: false, recoverStaged: false });
    await waitFor(() => expect(window.localStorage.getItem(STAGED)).toBeNull());
  });
});
