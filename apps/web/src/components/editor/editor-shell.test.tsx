// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stagedKey } from "./draft";
import { EditorShell } from "./editor-shell";

const KEY = "funwind:draft:1:thread:7";
const hidden = (container: HTMLElement) =>
  container.querySelector<HTMLInputElement>('input[name="source"]')!;

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

describe("EditorShell：隐藏字段与草稿", () => {
  it("隐藏字段的默认值是服务端原文（未编辑时提交原文）", async () => {
    const { container } = render(
      <EditorShell
        name="source"
        initialSource="原文 **粗**"
        draftKey={KEY}
        restoreDraft={false}
        label="正文"
      />,
    );
    expect(hidden(container).defaultValue).toBe("原文 **粗**");
    await waitFor(() => expect(hidden(container).value).toBe("原文 **粗**"));
  });

  it("失败跳回时恢复提交前暂存的正文：编辑器内容与隐藏字段都是暂存内容", async () => {
    window.localStorage.setItem(stagedKey(KEY), "草稿内容");
    const { container } = render(
      <EditorShell
        name="source"
        initialSource="服务端原文"
        draftKey={KEY}
        restoreDraft
        label="正文"
      />,
    );
    await waitFor(() => expect(hidden(container).value).toBe("草稿内容"));
    // 恢复后正文回到主草稿键，之后的编辑继续在主键上保存
    expect(window.localStorage.getItem(KEY)).toBe("草稿内容");
  });

  it("提交即暂存：主草稿键清除、正文移入暂存键，成功后不会残留提示", async () => {
    window.localStorage.setItem(KEY, "待提交的正文");
    const submitted = vi.fn();
    const { container } = render(
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submitted();
        }}
      >
        <EditorShell
          name="source"
          initialSource=""
          draftKey={KEY}
          restoreDraft={false}
          label="正文"
        />
      </form>,
    );
    await screen.findByRole("status");
    container.querySelector("form")!.requestSubmit();
    expect(submitted).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(window.localStorage.getItem(stagedKey(KEY))).toBe("待提交的正文");
  });

  it("普通进入且存在不同的草稿：提示恢复或丢弃，不静默覆盖也不静默删除", async () => {
    window.localStorage.setItem(KEY, "陈旧草稿");
    const { container } = render(
      <EditorShell
        name="source"
        initialSource="服务端原文"
        draftKey={KEY}
        restoreDraft={false}
        label="正文"
      />,
    );
    expect(await screen.findByRole("status")).toHaveTextContent("发现一份未发送的草稿");
    // 提示出现之前，隐藏字段仍是服务端原文；草稿也还在
    expect(hidden(container).value).toBe("服务端原文");
    expect(window.localStorage.getItem(KEY)).toBe("陈旧草稿");
  });

  it("选择恢复草稿：编辑器与隐藏字段改为草稿", async () => {
    window.localStorage.setItem(KEY, "我的草稿");
    const { container } = render(
      <EditorShell
        name="source"
        initialSource="服务端原文"
        draftKey={KEY}
        restoreDraft={false}
        label="正文"
      />,
    );
    await screen.findByRole("status");
    await act(async () => {
      screen.getByRole("button", { name: "恢复草稿" }).click();
    });
    await waitFor(() => expect(hidden(container).value).toBe("我的草稿"));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("选择丢弃：删除草稿，隐藏字段保持服务端原文", async () => {
    window.localStorage.setItem(KEY, "不要的草稿");
    const { container } = render(
      <EditorShell
        name="source"
        initialSource="服务端原文"
        draftKey={KEY}
        restoreDraft={false}
        label="正文"
      />,
    );
    await screen.findByRole("status");
    await act(async () => {
      screen.getByRole("button", { name: "丢弃" }).click();
    });
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(hidden(container).value).toBe("服务端原文");
  });

  it("草稿键为 null 时不写存储", async () => {
    const { container } = render(
      <EditorShell
        name="source"
        initialSource="x"
        draftKey={null}
        restoreDraft={false}
        label="正文"
      />,
    );
    await waitFor(() => expect(hidden(container).value).toBe("x"));
    expect(window.localStorage.length).toBe(0);
  });
});

describe("EditorShell：模式", () => {
  it("默认所见即所得，工具栏可见", async () => {
    render(
      <EditorShell
        name="source"
        initialSource=""
        draftKey={null}
        restoreDraft={false}
        label="正文"
      />,
    );
    expect(await screen.findByRole("toolbar", { name: "编辑工具栏" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "切换到源码" })).toBeEnabled();
  });

  it("强制源码模式：显示原因，不能切回所见即所得", async () => {
    render(
      <EditorShell
        name="source"
        initialSource="x"
        draftKey={null}
        restoreDraft={false}
        forceSource={{ reason: "本帖含有无法完整还原的格式，只能以源码编辑。" }}
        label="正文"
      />,
    );
    expect(screen.getByRole("note")).toHaveTextContent("只能以源码编辑");
    expect(screen.getByRole("button", { name: "切换到所见即所得" })).toBeDisabled();
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("切换到源码后内容保持不变，隐藏字段仍是同一份 Markdown", async () => {
    const { container } = render(
      <EditorShell
        name="source"
        initialSource={"第一行\n第二行"}
        draftKey={null}
        restoreDraft={false}
        label="正文"
      />,
    );
    await waitFor(() => expect(hidden(container).value).toBe("第一行\n第二行"));
    await act(async () => {
      screen.getByRole("button", { name: "切换到源码" }).click();
    });
    await waitFor(() => expect(container.querySelector(".cm-content")).not.toBeNull());
    expect(container.querySelector(".cm-content")?.textContent).toContain("第一行");
    expect(hidden(container).value).toBe("第一行\n第二行");
  });
});

describe("EditorShell：工具栏命令与边界", () => {
  it("插入门控块：隐藏字段出现带唯一 key 的门控语法", async () => {
    const { container } = render(
      <EditorShell
        name="source"
        initialSource=""
        draftKey={null}
        restoreDraft={false}
        label="正文"
      />,
    );
    await screen.findByRole("toolbar", { name: "编辑工具栏" });
    await act(async () => {
      screen.getByRole("button", { name: "插入门控块" }).click();
    });
    await waitFor(() =>
      expect(hidden(container).value).toContain(':::gate{key="g1" unlock="points" price="10"}'),
    );
    expect(hidden(container).value).toContain(":::");
  });

  it("接近上限的超长正文能载入，并原样留在隐藏字段中（未编辑）", async () => {
    const long = "这是一段很长的正文。\n".repeat(2000);
    const { container } = render(
      <EditorShell
        name="source"
        initialSource={long}
        draftKey={null}
        restoreDraft={false}
        label="正文"
      />,
    );
    await waitFor(() => expect(hidden(container).value).toBe(long));
    expect(hidden(container).value.length).toBeGreaterThan(20_000);
  });

  it("空内容：隐藏字段为空串，编辑器可用", async () => {
    const { container } = render(
      <EditorShell
        name="source"
        initialSource=""
        draftKey={null}
        restoreDraft={false}
        label="正文"
      />,
    );
    await waitFor(() => expect(hidden(container).value).toBe(""));
    expect(await screen.findByRole("textbox", { name: "正文" })).toBeInTheDocument();
  });
});
