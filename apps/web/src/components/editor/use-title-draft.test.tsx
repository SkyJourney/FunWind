import { act, fireEvent, render, screen } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as draft from "./draft";
import { useTitleDraft } from "./use-title-draft";

const KEY = "funwind:draft:1:edit:7";
const TITLE_KEY = `${KEY}:title`;

function TitleInput({
  draftKey = KEY,
  restore = true,
  enabled = true,
  initialTitle = "服务端标题",
  showInput = true,
}: {
  draftKey?: string | null;
  restore?: boolean;
  enabled?: boolean;
  initialTitle?: string;
  showInput?: boolean;
}) {
  const { titleRef, saveTitle } = useTitleDraft(draftKey, restore, enabled);
  return (
    <>
      {showInput && (
        <input aria-label="标题" ref={titleRef} defaultValue={initialTitle} onInput={saveTitle} />
      )}
      <button type="button" onClick={saveTitle}>
        保存
      </button>
    </>
  );
}

afterEach(() => vi.restoreAllMocks());

describe("useTitleDraft", () => {
  it("SSR 不读取或修改浏览器存储，输出仍是服务端标题", () => {
    window.localStorage.setItem(TITLE_KEY, "本地标题");
    const read = vi.spyOn(Storage.prototype, "getItem");
    const remove = vi.spyOn(Storage.prototype, "removeItem");
    const write = vi.spyOn(Storage.prototype, "setItem");
    const html = renderToString(<TitleInput />);
    expect(html).toContain('value="服务端标题"');
    expect(html).not.toContain("本地标题");
    expect(read).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("SSR 之后水合无恢复错误，挂载后才恢复本地标题", async () => {
    window.localStorage.setItem(TITLE_KEY, "本地标题");
    const container = document.createElement("div");
    container.innerHTML = renderToString(<TitleInput />);
    document.body.append(container);
    const onRecoverableError = vi.fn();
    let root: ReturnType<typeof hydrateRoot> | undefined;
    try {
      expect(container.querySelector("input")).toHaveValue("服务端标题");
      await act(async () => {
        root = hydrateRoot(container, <TitleInput />, { onRecoverableError });
      });
      expect(container.querySelector("input")).toHaveValue("本地标题");
      expect(onRecoverableError).not.toHaveBeenCalled();
    } finally {
      await act(async () => root?.unmount());
      container.remove();
    }
  });

  it.each(["本地标题", ""])("restore 恢复保存的标题（包括空串）：%j，恢复本身不写存储", (saved) => {
    window.localStorage.setItem(TITLE_KEY, saved);
    const write = vi.spyOn(Storage.prototype, "setItem");
    render(<TitleInput />);
    expect(screen.getByRole("textbox", { name: "标题" })).toHaveValue(saved);
    expect(write).not.toHaveBeenCalled();
  });

  it("没有保存的标题时保留现有标题，只有输入才写入 :title 键", () => {
    const write = vi.spyOn(Storage.prototype, "setItem");
    render(<TitleInput />);
    expect(screen.getByRole("textbox")).toHaveValue("服务端标题");
    expect(write).not.toHaveBeenCalled();
    fireEvent.input(screen.getByRole("textbox"), { target: { value: "新标题" } });
    expect(write).toHaveBeenCalledExactlyOnceWith(TITLE_KEY, "新标题");
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("restore=false 只清理标题键，保留现有标题及正文、暂存键，之后仍可保存输入", () => {
    window.localStorage.setItem(TITLE_KEY, "旧标题");
    window.localStorage.setItem(KEY, "正文草稿");
    window.localStorage.setItem(draft.stagedKey(KEY), "暂存正文");
    window.localStorage.setItem(draft.stagedKey(TITLE_KEY), "暂存标题");
    render(<TitleInput restore={false} />);
    expect(screen.getByRole("textbox")).toHaveValue("服务端标题");
    expect(window.localStorage.getItem(TITLE_KEY)).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBe("正文草稿");
    expect(window.localStorage.getItem(draft.stagedKey(KEY))).toBe("暂存正文");
    expect(window.localStorage.getItem(draft.stagedKey(TITLE_KEY))).toBe("暂存标题");
    fireEvent.input(screen.getByRole("textbox"), { target: { value: "刚输入" } });
    expect(window.localStorage.getItem(TITLE_KEY)).toBe("刚输入");
  });

  it.each([
    { draftKey: null, enabled: true, restore: true },
    { draftKey: KEY, enabled: false, restore: true },
    { draftKey: KEY, enabled: false, restore: false },
  ])("键为 null 或回复禁用时不读写删除：%j", (props) => {
    window.localStorage.setItem(TITLE_KEY, "保留");
    const read = vi.spyOn(Storage.prototype, "getItem");
    const remove = vi.spyOn(Storage.prototype, "removeItem");
    const write = vi.spyOn(Storage.prototype, "setItem");
    render(<TitleInput {...props} />);
    fireEvent.input(screen.getByRole("textbox"), { target: { value: "不保存" } });
    expect(read).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("没有标题输入框时恢复和保存均安全，不创建空标题草稿", () => {
    window.localStorage.setItem(TITLE_KEY, "保留");
    const write = vi.spyOn(Storage.prototype, "setItem");
    render(<TitleInput showInput={false} />);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(write).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(TITLE_KEY)).toBe("保留");
  });

  it("切换键和 restore 时沿用原 effect 行为，不在无关重渲染时覆盖正在输入的标题", () => {
    window.localStorage.setItem(TITLE_KEY, "第一份");
    window.localStorage.setItem(`${KEY}-other:title`, "第二份");
    const { rerender } = render(<TitleInput />);
    fireEvent.input(screen.getByRole("textbox"), { target: { value: "当前输入" } });
    window.localStorage.setItem(TITLE_KEY, "外部写入");
    rerender(<TitleInput />);
    expect(screen.getByRole("textbox")).toHaveValue("当前输入");
    rerender(<TitleInput draftKey={`${KEY}-other`} />);
    expect(screen.getByRole("textbox")).toHaveValue("第二份");
    rerender(<TitleInput draftKey={`${KEY}-other`} restore={false} />);
    expect(screen.getByRole("textbox")).toHaveValue("第二份");
    expect(window.localStorage.getItem(`${KEY}-other:title`)).toBeNull();
  });

  it("回复禁用后重新启用标题恢复时读取同一标题键", () => {
    window.localStorage.setItem(TITLE_KEY, "主题草稿");
    const { rerender } = render(<TitleInput enabled={false} />);
    expect(screen.getByRole("textbox")).toHaveValue("服务端标题");
    rerender(<TitleInput enabled />);
    expect(screen.getByRole("textbox")).toHaveValue("主题草稿");
  });

  it("存储不可用时恢复、输入和清理不抛异常，也不改写现有标题", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("读取不可用");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("写入不可用");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("清理不可用");
    });
    const { rerender } = render(<TitleInput />);
    expect(screen.getByRole("textbox")).toHaveValue("服务端标题");
    expect(() =>
      fireEvent.input(screen.getByRole("textbox"), { target: { value: "继续输入" } }),
    ).not.toThrow();
    expect(() => rerender(<TitleInput restore={false} />)).not.toThrow();
    expect(screen.getByRole("textbox")).toHaveValue("继续输入");
  });

  it("草稿读取意外抛异常时仍降级为现有标题", () => {
    vi.spyOn(draft, "readDraft").mockImplementation(() => {
      throw new Error("意外异常");
    });
    expect(() => render(<TitleInput />)).not.toThrow();
    expect(screen.getByRole("textbox")).toHaveValue("服务端标题");
  });
});
