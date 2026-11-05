import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, type ComponentProps } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemePackEditorForm } from "./theme-pack-editor-form";
import { themePackSaveDraftKey, type ThemePackSaveDraft } from "./theme/pack-save-draft";
import type { ThemePackDefinition } from "@/lib/theme/surface-schema";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const definition = {
  pwa: { themeColor: "#123456", backgroundColor: "#abcdef" },
  surfaces: {
    header: {
      light: { fill: { type: "solid" as const, color: "#ffffff" } },
      dark: { fill: { type: "solid" as const, color: "#111111" } },
    },
  },
};
const props: ComponentProps<typeof ThemePackEditorForm> = {
  action: async () => {},
  userId: 7,
  packId: "test",
  revision: 4,
  name: "服务端名称",
  description: "服务端说明",
  initialDefinition: definition,
  saved: false,
  surfaces: [{ id: "header", label: "顶栏", caps: ["fill"] }],
  decorFiles: [],
};
const KEY = themePackSaveDraftKey(props.userId, props.packId);
const saved: ThemePackSaveDraft = {
  userId: props.userId,
  packId: props.packId,
  expectedRevision: 3,
  name: "本地名称",
  description: "本地说明",
  definition: {
    ...definition,
    surfaces: { header: { light: { fill: { type: "solid", color: "#2468ac" } } } },
  },
};
const seed = (draft: ThemePackSaveDraft = saved) =>
  sessionStorage.setItem(themePackSaveDraftKey(draft.userId, draft.packId), JSON.stringify(draft));
const read = () => JSON.parse(sessionStorage.getItem(KEY)!) as ThemePackSaveDraft;
const name = () => screen.getByRole("textbox", { name: "主题名称" });
const description = () => screen.getByRole("textbox", { name: "说明" });
const color = () => screen.getByTestId("theme-fill-solid-color");
const save = () => screen.getByRole("button", { name: "保存主题包" });
const loadLatest = () => screen.getByRole("button", { name: "放弃草稿并载入最新版本" });
const revision = (container: HTMLElement) =>
  container.querySelector<HTMLInputElement>('input[name="revision"]')!.value;
const form = (container: HTMLElement) => container.querySelector("form")!;

function mount(overrides: Partial<typeof props> = {}) {
  return render(<ThemePackEditorForm {...props} {...overrides} />);
}

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe("主题保存表单：完整草稿与版本保护", () => {
  it("StrictMode 错误恢复完整快照，不写回初始定义，也不升级原 expectedRevision", () => {
    seed();
    const write = vi.spyOn(Storage.prototype, "setItem");
    const remove = vi.spyOn(Storage.prototype, "removeItem");
    const { container } = render(
      <StrictMode>
        <ThemePackEditorForm {...props} error="conflict" />
      </StrictMode>,
    );
    expect(name()).toHaveValue(saved.name);
    expect(description()).toHaveValue(saved.description);
    expect(color()).toHaveValue("#2468ac");
    expect(revision(container)).toBe("3");
    expect(save()).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("原始版本 v3");
    expect(write).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(read()).toEqual(saved);
  });

  it("只在用户改字段、配置或提交时写完整快照，空名称与原始版本也保留", () => {
    const { container } = mount();
    expect(sessionStorage.getItem(KEY)).toBeNull();
    fireEvent.change(name(), { target: { value: "" } });
    fireEvent.change(description(), { target: { value: "未保存说明" } });
    fireEvent.change(color(), { target: { value: "#13579b" } });
    expect(read()).toMatchObject({
      userId: 7,
      packId: "test",
      expectedRevision: 4,
      name: "",
      description: "未保存说明",
      definition: { surfaces: { header: { light: { fill: { color: "#13579b" } } } } },
    });
    const snapshot = sessionStorage.getItem(KEY);
    fireEvent.click(screen.getByRole("button", { name: "深色档" }));
    expect(sessionStorage.getItem(KEY)).toBe(snapshot);
    expect(revision(container)).toBe("4");
  });

  it("surfaces 新引用不会清档，刷新错误页后名称、说明和原版本仍恢复", () => {
    const { container, rerender, unmount } = mount();
    fireEvent.change(name(), { target: { value: "输入中的名称" } });
    fireEvent.change(description(), { target: { value: "输入中的说明" } });
    fireEvent.change(color(), { target: { value: "#13579b" } });
    const snapshot = read();
    const remove = vi.spyOn(Storage.prototype, "removeItem");
    rerender(<ThemePackEditorForm {...props} surfaces={[...props.surfaces]} />);
    expect(read()).toEqual(snapshot);
    expect(remove).not.toHaveBeenCalled();
    expect(revision(container)).toBe("4");
    unmount();
    const refreshed = mount({ revision: 5, error: "conflict", name: "他人已保存名称" });
    expect(name()).toHaveValue("输入中的名称");
    expect(description()).toHaveValue("输入中的说明");
    expect(color()).toHaveValue("#13579b");
    expect(revision(refreshed.container)).toBe("4");
    expect(read()).toEqual(snapshot);
    expect(save()).toBeDisabled();
  });

  it("错误页 surfaces 新引用不会再次读取旧档覆盖当前编辑", () => {
    seed();
    const { rerender } = mount({ error: "invalid-definition" });
    fireEvent.change(name(), { target: { value: "恢复后继续编辑" } });
    fireEvent.change(color(), { target: { value: "#13579b" } });
    const current = read();
    seed();
    const write = vi.spyOn(Storage.prototype, "setItem");
    rerender(
      <ThemePackEditorForm {...props} error="invalid-definition" surfaces={[...props.surfaces]} />,
    );
    expect(name()).toHaveValue(current.name);
    expect(color()).toHaveValue("#13579b");
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    { userId: 8, packId: "test" },
    { userId: 7, packId: "other" },
  ])("不同账号或主题包不恢复也不清理别人的草稿：%j", (identity) => {
    seed();
    mount({ ...identity, error: "conflict" });
    expect(name()).toHaveValue(props.name);
    expect(description()).toHaveValue(props.description);
    expect(color()).toHaveValue("#ffffff");
    expect(read()).toEqual(saved);
    fireEvent.change(name(), { target: { value: "当前账号的另一份草稿" } });
    expect(read()).toEqual(saved);
    expect(
      JSON.parse(sessionStorage.getItem(themePackSaveDraftKey(identity.userId, identity.packId))!),
    ).toMatchObject(identity);
  });

  it("同一树内切换账号或主题包，不沿用上个表单内存状态", () => {
    const { rerender } = mount();
    fireEvent.change(name(), { target: { value: "旧账号草稿" } });
    rerender(<ThemePackEditorForm {...props} userId={8} error="conflict" />);
    expect(name()).toHaveValue(props.name);
    rerender(<ThemePackEditorForm {...props} packId="other" error="conflict" />);
    expect(name()).toHaveValue(props.name);
    rerender(<ThemePackEditorForm {...props} error="conflict" />);
    expect(name()).toHaveValue("旧账号草稿");
  });

  it.each([false, true])(
    "普通进入或保存成功清掉本账号本包旧档，不写服务端初始快照（saved=%s）",
    (isSaved) => {
      seed();
      seed({ ...saved, userId: 8 });
      const write = vi.spyOn(Storage.prototype, "setItem");
      render(
        <StrictMode>
          <ThemePackEditorForm {...props} saved={isSaved} />
        </StrictMode>,
      );
      expect(name()).toHaveValue(props.name);
      expect(sessionStorage.getItem(KEY)).toBeNull();
      expect(sessionStorage.getItem(themePackSaveDraftKey(8, props.packId))).not.toBeNull();
      expect(write).not.toHaveBeenCalled();
    },
  );

  it.each([
    "{坏JSON",
    JSON.stringify({ ...saved, expectedRevision: 0 }),
    JSON.stringify(definition),
  ])("坏档或旧版仅 definition 档不能拼接最新 revision 后提交：%s", (raw) => {
    sessionStorage.setItem(KEY, raw);
    const { container } = mount({ error: "conflict" });
    expect(name()).toHaveValue(props.name);
    expect(revision(container)).toBe("4");
    expect(save()).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("未找到可恢复的完整草稿");
    expect(sessionStorage.getItem(KEY)).toBe(raw);
  });

  it("忽略旧的不分账号键和冒充账号的快照", () => {
    sessionStorage.setItem(`fw.theme-pack.draft.${props.packId}`, JSON.stringify(definition));
    sessionStorage.setItem(KEY, JSON.stringify({ ...saved, userId: 8 }));
    mount({ error: "conflict" });
    expect(name()).toHaveValue(props.name);
    expect(save()).toBeDisabled();
  });

  it("并发真实内容改变后重复提交被阻止，既不覆盖服务端也不升级原 revision", () => {
    const action = vi.fn(async () => {});
    const { container, rerender } = mount({ action });
    fireEvent.change(name(), { target: { value: "我的未保存名称" } });
    fireEvent.change(description(), { target: { value: "我的未保存说明" } });
    const server = { revision: 5, name: "另一管理员保存的名称", description: "另一管理员的说明" };
    rerender(<ThemePackEditorForm {...props} {...server} action={action} error="conflict" />);
    const snapshot = sessionStorage.getItem(KEY);
    for (let retry = 0; retry < 2; retry++) fireEvent.submit(form(container));
    expect(action).not.toHaveBeenCalled();
    expect(revision(container)).toBe("4");
    expect(name()).toHaveValue("我的未保存名称");
    expect(sessionStorage.getItem(KEY)).toBe(snapshot);
    expect(server).toEqual({
      revision: 5,
      name: "另一管理员保存的名称",
      description: "另一管理员的说明",
    });
  });

  it("旁路 RSC 刷新只更新服务端版本提示，不清空当前草稿或换锁", () => {
    const { container, rerender } = mount();
    fireEvent.change(name(), { target: { value: "旁路刷新前的名称" } });
    fireEvent.change(color(), { target: { value: "#13579b" } });
    const snapshot = read();
    rerender(
      <ThemePackEditorForm
        {...props}
        revision={5}
        name="服务端新名称"
        surfaces={[...props.surfaces]}
      />,
    );
    expect(name()).toHaveValue("旁路刷新前的名称");
    expect(color()).toHaveValue("#13579b");
    expect(revision(container)).toBe("4");
    expect(read()).toEqual(snapshot);
    expect(save()).toBeDisabled();
  });

  it("存储写失败时同树错误刷新仍保留内存草稿，不清空输入", () => {
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("配额不足");
    });
    const { container, rerender } = mount();
    fireEvent.change(name(), { target: { value: "未写入存储的草稿" } });
    fireEvent.change(color(), { target: { value: "#13579b" } });
    expect(write).toHaveBeenCalled();
    rerender(<ThemePackEditorForm {...props} error="conflict" revision={5} />);
    expect(name()).toHaveValue("未写入存储的草稿");
    expect(color()).toHaveValue("#13579b");
    expect(revision(container)).toBe("4");
    expect(save()).toBeDisabled();
    expect(screen.queryByText(/未找到可恢复的完整草稿/)).not.toBeInTheDocument();
  });

  it("保存成功后才清除对应草稿；后续旁路 revision 刷新不丢新输入", async () => {
    const action = vi.fn(async (_data: FormData) => {});
    const { container, rerender } = mount({ action });
    fireEvent.change(name(), { target: { value: "已提交名称" } });
    fireEvent.change(color(), { target: { value: "#13579b" } });
    const submitted = read();
    fireEvent.submit(form(container));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const submissionId = String(action.mock.calls[0][0].get("submissionId"));
    expect(submissionId).toMatch(/^[0-9a-f-]{36}$/i);
    rerender(
      <ThemePackEditorForm
        {...props}
        revision={5}
        ack="not-this-submission"
        action={action}
        name={submitted.name}
        initialDefinition={submitted.definition}
        saved
      />,
    );
    expect(revision(container)).toBe("4");
    expect(read()).toEqual(submitted);
    rerender(
      <ThemePackEditorForm
        {...props}
        revision={5}
        ack={submissionId}
        action={action}
        name={submitted.name}
        initialDefinition={submitted.definition}
        saved
      />,
    );
    expect(name()).toHaveValue("已提交名称");
    expect(color()).toHaveValue("#13579b");
    expect(revision(container)).toBe("5");
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(save()).toBeEnabled();
    fireEvent.change(name(), { target: { value: "保存后的新输入" } });
    const postSave = read();
    rerender(
      <ThemePackEditorForm
        {...props}
        revision={6}
        name="旁路操作更新名称"
        initialDefinition={submitted.definition}
        saved
      />,
    );
    expect(name()).toHaveValue("保存后的新输入");
    expect(read()).toEqual(postSave);
    expect(revision(container)).toBe("5");
    expect(save()).toBeDisabled();
  });

  it("saved 残留时本次提交 pending 遇旁路 revision 增长不换代或清稿", async () => {
    let finish!: () => void;
    const action = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { container, rerender } = mount({ saved: true, action });
    fireEvent.change(name(), { target: { value: "pending 中的名称" } });
    fireEvent.change(description(), { target: { value: "pending 中的说明" } });
    fireEvent.change(color(), { target: { value: "#13579b" } });
    fireEvent.submit(form(container));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const snapshot = read();
    rerender(
      <ThemePackEditorForm
        {...props}
        action={action}
        saved
        revision={5}
        name="LOGO 刷新后的服务端名称"
      />,
    );
    expect(name()).toHaveValue("pending 中的名称");
    expect(description()).toHaveValue("pending 中的说明");
    expect(color()).toHaveValue("#13579b");
    expect(revision(container)).toBe("4");
    expect(read()).toEqual(snapshot);
    await act(async () => finish());
  });

  it("服务端拒绝的非法 image asset 草稿仍恢复全部输入与原版本，预览不输出非法资源", () => {
    const invalid: ThemePackSaveDraft = {
      ...saved,
      expectedRevision: props.revision,
      definition: {
        surfaces: {
          header: {
            light: {
              fill: {
                type: "image",
                asset: "",
                position: "50% 50%",
                size: "cover",
                repeat: "no-repeat",
                blend: "normal",
                opacity: 2,
              },
              blur: 99,
            },
          },
        },
      },
    };
    seed(invalid);
    const { container } = mount({ error: "invalid-definition" });
    expect(name()).toHaveValue(invalid.name);
    expect(description()).toHaveValue(invalid.description);
    expect(revision(container)).toBe(String(invalid.expectedRevision));
    const payload = JSON.parse(
      container.querySelector<HTMLInputElement>('input[name="definition"]')!.value,
    );
    expect(payload.surfaces.header.light).toEqual(invalid.definition.surfaces.header.light);
    expect(
      screen.getByTestId("theme-preview").style.getPropertyValue("--sf-header-bg"),
    ).not.toContain("url(");
    expect(read()).toEqual(invalid);
    fireEvent.change(description(), { target: { value: "继续修改说明" } });
    expect(read().definition).toEqual(invalid.definition);
  });

  it("明确确认前不能丢弃草稿；确认后载入服务端快照再编辑保存", async () => {
    seed();
    const action = vi.fn(async (_data: FormData) => {});
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { container } = mount({ error: "conflict", action });
    fireEvent.click(loadLatest());
    expect(name()).toHaveValue(saved.name);
    expect(revision(container)).toBe("3");
    expect(read()).toEqual(saved);
    expect(save()).toBeDisabled();

    confirm.mockReturnValue(true);
    fireEvent.click(loadLatest());
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("放弃当前未保存"));
    expect(name()).toHaveValue(props.name);
    expect(description()).toHaveValue(props.description);
    expect(color()).toHaveValue("#ffffff");
    expect(revision(container)).toBe("4");
    expect(save()).toBeEnabled();
    expect(sessionStorage.getItem(KEY)).toBeNull();
    fireEvent.change(description(), { target: { value: "基于新版本重新编辑" } });
    fireEvent.submit(form(container));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const submitted = action.mock.calls[0][0];
    expect(submitted.get("revision")).toBe("4");
    expect(submitted.get("name")).toBe(props.name);
    expect(submitted.get("description")).toBe("基于新版本重新编辑");
  });

  it("存储不可用时明确提示，仍可编辑且不会冒充恢复成功", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("不可用");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("不可用");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("不可用");
    });
    mount();
    fireEvent.change(name(), { target: { value: "存储不可用时的输入" } });
    expect(name()).toHaveValue("存储不可用时的输入");
    expect(screen.getByRole("alert")).toHaveTextContent("浏览器无法暂存草稿");
    expect(save()).toBeEnabled();
  });
});

describe("主题保存表单：SSR 与水合", () => {
  it("SSR 不读写 sessionStorage；首帧只输出服务端数据并禁止抢先提交", () => {
    seed();
    const get = vi.spyOn(Storage.prototype, "getItem");
    const write = vi.spyOn(Storage.prototype, "setItem");
    const remove = vi.spyOn(Storage.prototype, "removeItem");
    const html = renderToString(<ThemePackEditorForm {...props} error="conflict" />);
    expect(html).toContain(props.name);
    expect(html).not.toContain(saved.name);
    expect(get).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    const container = document.createElement("div");
    container.innerHTML = html;
    expect(container.querySelector('button[type="submit"]')).toBeDisabled();
  });

  it("SSR 后 StrictMode 水合恢复完整草稿，零恢复性错误与零初始覆写", async () => {
    seed();
    const element = (
      <StrictMode>
        <ThemePackEditorForm {...props} error="conflict" />
      </StrictMode>
    );
    const container = document.createElement("div");
    container.innerHTML = renderToString(element);
    document.body.append(container);
    const onRecoverableError = vi.fn();
    const error = vi.spyOn(console, "error");
    const write = vi.spyOn(Storage.prototype, "setItem");
    let root: ReturnType<typeof hydrateRoot> | undefined;
    try {
      expect(container.querySelector('input[name="name"]')).toHaveValue(props.name);
      await act(async () => {
        root = hydrateRoot(container, element, { onRecoverableError });
      });
      expect(container.querySelector('input[name="name"]')).toHaveValue(saved.name);
      expect(container.querySelector('input[name="description"]')).toHaveValue(saved.description);
      expect(revision(container)).toBe("3");
      expect(container.querySelector('input[name="definition"]')!.getAttribute("value")).toContain(
        "#2468ac",
      );
      expect(onRecoverableError).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(read()).toEqual(saved);
    } finally {
      await act(async () => root?.unmount());
      container.remove();
    }
  });
});

describe("主题保存表单：全站语义令牌（G-19）", () => {
  const serverTokens: ThemePackDefinition = {
    ...definition,
    tokens: { light: { colors: { primary: "#112233" }, radius: "md" } },
  };
  const tokenPanel = () => screen.getByTestId("theme-token-editor") as HTMLDetailsElement;
  const primary = () => screen.getByRole("textbox", { name: "主色（全站）" });
  const payload = (container: HTMLElement) =>
    JSON.parse(
      container.querySelector<HTMLInputElement>('input[name="definition"]')!.value,
    ) as ThemePackDefinition;

  it("编辑令牌即写入完整快照；出错刷新后从快照恢复令牌、名称与原版本", () => {
    const first = mount({ initialDefinition: serverTokens });
    tokenPanel().open = true;
    fireEvent.change(primary(), { target: { value: "#ABCDEF" } });
    fireEvent.change(name(), { target: { value: "改过的名称" } });
    const draft = read();
    expect(draft.expectedRevision).toBe(4);
    expect(draft.name).toBe("改过的名称");
    expect(draft.definition.tokens).toEqual({
      light: { colors: { primary: "#abcdef" }, radius: "md" },
    });
    first.unmount();

    const { container } = mount({ initialDefinition: serverTokens, error: "invalid-definition" });
    expect(name()).toHaveValue("改过的名称");
    tokenPanel().open = true;
    expect(primary()).toHaveValue("#abcdef");
    expect(payload(container).tokens).toEqual(draft.definition.tokens);
    expect(revision(container)).toBe("4");
  });

  it("冲突时草稿里的令牌与原版本一并保留；确认载入最新版本后换成服务端的令牌", () => {
    const stale: ThemePackSaveDraft = {
      ...saved,
      definition: { ...definition, tokens: { light: { colors: { primary: "#445566" } } } },
    };
    seed(stale);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { container } = mount({ initialDefinition: serverTokens, error: "conflict" });
    tokenPanel().open = true;
    expect(primary()).toHaveValue("#445566");
    expect(revision(container)).toBe("3");
    expect(save()).toBeDisabled();
    expect(read().definition.tokens).toEqual({ light: { colors: { primary: "#445566" } } });

    fireEvent.click(loadLatest());
    tokenPanel().open = true;
    expect(primary()).toHaveValue("#112233");
    expect(payload(container).tokens).toEqual(serverTokens.tokens);
    expect(revision(container)).toBe("4");
    expect(save()).toBeEnabled();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("草稿里的令牌不合 schema：整份草稿按损坏处理，显示服务端内容并给出提示", () => {
    const broken = {
      ...saved,
      expectedRevision: props.revision,
      definition: { ...definition, tokens: { light: { radius: "huge" } } },
    };
    seed(broken as unknown as ThemePackSaveDraft);
    const { container } = mount({ initialDefinition: serverTokens, error: "invalid-definition" });
    expect(name()).toHaveValue(props.name);
    expect(color()).toHaveValue("#ffffff");
    expect(payload(container).tokens).toEqual(serverTokens.tokens);
    expect(screen.getByText(/未找到可恢复的完整草稿/)).toBeInTheDocument();
  });

  it("草稿把令牌全部恢复继承后，恢复出来的定义里没有 tokens，服务端旧令牌不会复活", () => {
    const cleared: ThemePackSaveDraft = {
      ...saved,
      expectedRevision: props.revision,
      definition: { ...definition },
    };
    seed(cleared);
    const { container } = mount({ initialDefinition: serverTokens, error: "invalid-definition" });
    expect(Object.hasOwn(payload(container), "tokens")).toBe(false);
    tokenPanel().open = true;
    expect(screen.queryByRole("textbox", { name: "主色（全站）" })).toBeNull();
  });

  it("令牌面板与颜色框里按回车不提交表单；名称框里按回车照常提交", async () => {
    const action = vi.fn(async (_data: FormData) => {});
    const shadow = { x: 0, y: 1, blur: 3, spread: 0, color: "#000000", alpha: 0.1 };
    mount({
      action,
      initialDefinition: {
        ...definition,
        tokens: { light: { colors: { primary: "#112233" }, shadows: { s1: shadow } } },
      },
    });
    tokenPanel().open = true;
    for (const label of ["主色（全站）", "阴影 1 模糊", "浏览器主题色"]) {
      await userEvent.type(screen.getByRole("textbox", { name: label }), "{Enter}");
    }
    expect(action).not.toHaveBeenCalled();
    await userEvent.type(name(), "{Enter}");
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
  });
});
