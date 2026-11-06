import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThemePackDefinition } from "@/lib/theme/surface-schema";
import { ThemePackEditor, type SurfaceMeta } from "./theme-pack-editor";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const FILE = `decor-${"a".repeat(32)}.png`;
const OTHER_FILE = `decor-${"b".repeat(32)}.png`;
const surfaces: readonly SurfaceMeta[] = [
  {
    id: "header",
    label: "顶栏",
    caps: ["fill", "overlay", "contentSlot", "border", "text", "blur"],
  },
  { id: "forum-band", label: "板块卡片", caps: ["fill", "text"] },
  { id: "hero-image", label: "主视觉", caps: ["contentSlot"] },
  { id: "footer", label: "页脚", caps: ["fill"] },
];
const initialDefinition: ThemePackDefinition = {
  pwa: { themeColor: "#123456", backgroundColor: "#abcdef" },
  surfaces: {
    header: {
      light: { fill: { type: "solid", color: "#ffffff" } },
      dark: { fill: { type: "solid", color: "#111111" }, blur: 4 },
    },
  },
};

function mount(props: Partial<Parameters<typeof ThemePackEditor>[0]> = {}) {
  const result = render(
    <ThemePackEditor
      surfaces={surfaces}
      initialDefinition={initialDefinition}
      decorFiles={[
        { file: FILE, name: "底纹" },
        { file: OTHER_FILE, name: "装饰" },
      ]}
      {...props}
    />,
  );
  const input = result.container.querySelector<HTMLInputElement>('input[name="definition"]')!;
  return { ...result, input, definition: () => JSON.parse(input.value) as ThemePackDefinition };
}

const fillControls = () => within(screen.getByRole("group", { name: "背景填充" }));
const overlayControls = () => within(screen.getByRole("group", { name: "覆盖遮罩" }));
const preview = () => screen.getByTestId("theme-preview");

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe("ThemePackEditor：草稿与预览契约", () => {
  it("隐藏 definition 保留 PWA 与原有深色档，修改 PWA/浅色不会覆盖深色或原定义", () => {
    const before = structuredClone(initialDefinition);
    const { input, definition } = mount();
    expect(input).toHaveAttribute("type", "hidden");
    expect(definition()).toEqual(initialDefinition);
    fireEvent.change(screen.getByLabelText("浏览器主题色"), { target: { value: "#112233" } });
    fireEvent.change(screen.getByLabelText("PWA 背景色"), { target: { value: "#445566" } });
    fireEvent.change(screen.getByTestId("theme-fill-solid-color"), {
      target: { value: "#778899" },
    });
    expect(definition()).toEqual({
      pwa: { themeColor: "#112233", backgroundColor: "#445566" },
      surfaces: {
        header: {
          light: { fill: { type: "solid", color: "#778899" } },
          dark: before.surfaces.header.dark,
        },
      },
    });
    expect(initialDefinition).toEqual(before);
  });

  it("浅深档、区域和设备切换保留 DOM 属性与草稿，不触发自动存储或请求", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const store = vi.spyOn(Storage.prototype, "setItem");
    const { input } = mount();
    const json = input.value;
    expect(screen.getByRole("region", { name: "主题区域设置" })).toHaveClass("space-y-3");
    expect(preview()).toHaveAttribute("data-surface", "header");
    expect(preview()).toHaveAttribute("data-mode", "light");
    expect(preview()).toHaveClass("w-full");
    fireEvent.click(screen.getByRole("button", { name: "深色档" }));
    expect(preview()).toHaveAttribute("data-mode", "dark");
    expect(screen.getByRole("button", { name: "深色档" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("theme-fill-solid-color")).toHaveValue("#111111");
    fireEvent.click(screen.getByRole("button", { name: "移动" }));
    expect(preview()).toHaveClass("w-[375px]", "max-w-full");
    fireEvent.click(screen.getByRole("button", { name: "页脚" }));
    expect(preview()).toHaveAttribute("data-surface", "footer");
    expect(screen.getByText(/当前区域尚无深色定义/)).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "覆盖遮罩" })).not.toBeInTheDocument();
    expect(screen.getByTestId("asset-library-surface-hint")).toHaveTextContent(
      "当前区域：页脚（footer）",
    );
    fireEvent.click(screen.getByRole("button", { name: "桌面" }));
    fireEvent.click(screen.getByRole("button", { name: "浅色档" }));
    expect(input.value).toBe(json);
    expect(store).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("缺省 PWA 使用原默认值，未配置区域预览按当前档回退 default 包", () => {
    const { definition } = mount({
      initialDefinition: { surfaces: {} },
      fallbackDefinition: {
        surfaces: {
          header: {
            light: { fill: { type: "solid", color: "#ccddee" } },
            dark: { fill: { type: "solid", color: "#223344" } },
          },
        },
      },
    });
    expect(definition()).toEqual({ surfaces: {} });
    expect(screen.getByLabelText("浏览器主题色")).toHaveValue("#0e7490");
    expect(screen.getByLabelText("PWA 背景色")).toHaveValue("#f8fafc");
    expect(preview().style.getPropertyValue("--sf-header-bg")).toBe("#ccddee");
    fireEvent.click(screen.getByRole("button", { name: "深色档" }));
    expect(preview().style.getPropertyValue("--sf-header-bg")).toBe("#223344");
    fireEvent.click(fillControls().getByRole("radio", { name: "纯色" }));
    expect(definition().surfaces.header).toEqual({
      light: {},
      dark: { fill: { type: "solid", color: "#f8fafc" } },
    });
  });
});

describe("ThemePackEditor：渐变控件", () => {
  it("线性填充角度、色标颜色/透明度/位置及增删保持原数值和 2–8 个边界", () => {
    const { definition } = mount();
    fireEvent.click(fillControls().getByRole("radio", { name: "线性渐变" }));
    const controls = fillControls();
    expect(controls.getByRole("slider", { name: /^角度/ })).toHaveAttribute("max", "359");
    expect(controls.queryByRole("button", { name: /删除填充色标/ })).not.toBeInTheDocument();
    fireEvent.change(controls.getByRole("slider", { name: /^角度/ }), { target: { value: "243" } });
    fireEvent.change(controls.getByLabelText("填充色标 1 颜色"), { target: { value: "#223344" } });
    fireEvent.change(controls.getAllByRole("spinbutton", { name: "透明度" })[0], {
      target: { value: "0.35" },
    });
    fireEvent.change(controls.getAllByRole("spinbutton", { name: "位置" })[0], {
      target: { value: "24" },
    });
    expect(definition().surfaces.header.light.fill).toEqual({
      type: "linear",
      angle: 243,
      stops: [
        { color: "#223344", alpha: 0.35, position: 24 },
        { color: "#f6f3e7", alpha: 1, position: 100 },
      ],
    });
    expect(controls.getByText("243°")).toHaveClass("tabular-nums");
    for (let count = 2; count < 8; count++) {
      fireEvent.click(controls.getByRole("button", { name: "添加色标" }));
    }
    expect(controls.queryByRole("button", { name: "添加色标" })).not.toBeInTheDocument();
    expect(controls.getAllByLabelText(/填充色标 \d+ 颜色/)).toHaveLength(8);
    fireEvent.click(controls.getByRole("button", { name: "删除填充色标 3" }));
    expect(controls.getAllByLabelText(/填充色标 \d+ 颜色/)).toHaveLength(7);
    expect(controls.getByRole("button", { name: "添加色标" })).toBeInTheDocument();
    const fill = definition().surfaces.header.light.fill;
    if (fill?.type !== "linear") throw new Error("应为线性渐变");
    expect(fill.stops[6]).toEqual({ color: "#ffffff", alpha: 1, position: 100 });
    expect(definition().surfaces.header.dark).toEqual(initialDefinition.surfaces.header.dark);
  });

  it("径向填充保留 circle 默认形状，不显示角度", () => {
    const { definition } = mount();
    fireEvent.click(fillControls().getByRole("radio", { name: "径向渐变" }));
    expect(fillControls().queryByRole("slider")).not.toBeInTheDocument();
    expect(definition().surfaces.header.light.fill).toEqual({
      type: "radial",
      shape: "circle",
      stops: [
        { color: "#147ba9", alpha: 1, position: 0 },
        { color: "#f6f3e7", alpha: 1, position: 100 },
      ],
    });
  });

  it("遮罩默认角度/形状不变，调整角度与色标保留遮罩强度，选择无只清理遮罩", () => {
    const { definition } = mount();
    const controls = overlayControls();
    fireEvent.click(controls.getByRole("radio", { name: "线性渐变" }));
    expect(controls.getByRole("slider", { name: /^角度/ })).toHaveValue("105");
    fireEvent.change(controls.getByRole("spinbutton", { name: "遮罩强度" }), {
      target: { value: "0.42" },
    });
    fireEvent.change(controls.getByRole("slider", { name: /^角度/ }), { target: { value: "189" } });
    fireEvent.change(controls.getByLabelText("遮罩色标 1 颜色"), { target: { value: "#112233" } });
    fireEvent.click(controls.getByRole("button", { name: "添加遮罩色标" }));
    fireEvent.click(controls.getByRole("button", { name: "删除遮罩色标 2" }));
    expect(definition().surfaces.header.light.overlay).toEqual({
      type: "linear",
      angle: 189,
      overlayOpacity: 0.42,
      stops: [
        { color: "#112233", alpha: 0, position: 0 },
        { color: "#ffffff", alpha: 1, position: 100 },
      ],
    });
    fireEvent.click(controls.getByRole("radio", { name: "径向渐变" }));
    expect(definition().surfaces.header.light.overlay).toMatchObject({
      type: "radial",
      shape: "ellipse",
      overlayOpacity: 1,
    });
    expect(controls.queryByRole("slider")).not.toBeInTheDocument();
    fireEvent.click(controls.getByRole("radio", { name: "无" }));
    expect(definition().surfaces.header.light).toEqual(initialDefinition.surfaces.header.light);
  });
});

describe("ThemePackEditor：颜色输入（ColorField 接线）", () => {
  /** 浅 / 深两档都有填充、遮罩、边框、文字色，且互不相同，便于确认切换后显示的是各自的值 */
  const rich: ThemePackDefinition = {
    surfaces: {
      header: {
        light: {
          fill: { type: "solid", color: "#ffffff" },
          overlay: { type: "solid", color: "#010101" },
          border: { color: "#020202", width: 1, style: "solid" },
          text: { primary: "#030303", muted: "#040404", link: "#050505" },
        },
        dark: {
          fill: { type: "solid", color: "#111111" },
          overlay: { type: "solid", color: "#212121" },
          border: { color: "#313131", width: 1, style: "solid" },
          text: { primary: "#414141", muted: "#515151", link: "#616161" },
        },
      },
    },
  };
  const field = (name: string) => screen.getByRole("textbox", { name });

  it("text 缺失时，三项文字色显示的就是各自真正会写入的默认值", () => {
    mount();
    expect(field("正文（文字色）")).toHaveValue("#334155");
    expect(field("弱化文字（文字色）")).toHaveValue("#64748b");
    expect(field("链接（文字色）")).toHaveValue("#147ba9");
  });

  it("PWA 两个颜色的可访问名称就是可见文字", () => {
    mount();
    expect(field("浏览器主题色")).toHaveValue("#123456");
    expect(field("PWA 背景色")).toHaveValue("#abcdef");
  });

  it("遮罩纯色：改的是遮罩颜色，不动填充", () => {
    const { definition } = mount();
    fireEvent.click(overlayControls().getByRole("radio", { name: "纯色" }));
    fireEvent.change(field("遮罩颜色"), { target: { value: "#0a0b0c" } });
    const light = definition().surfaces.header.light;
    expect(light.overlay).toMatchObject({ type: "solid", color: "#0a0b0c" });
    expect(light.fill).toEqual({ type: "solid", color: "#ffffff" });
  });

  it("边框颜色：改颜色时补全宽度与线型的默认值", () => {
    const { definition } = mount();
    expect(field("边框颜色")).toHaveValue("#e2e8f0");
    fireEvent.change(field("边框颜色"), { target: { value: "#102030" } });
    expect(definition().surfaces.header.light.border).toEqual({
      color: "#102030",
      width: 1,
      style: "solid",
    });
  });

  it.each([
    ["primary", "正文"],
    ["muted", "弱化文字"],
    ["link", "链接"],
  ] as const)("文字色 %s（%s）：只改这一项，其余补默认值", (key, label) => {
    const { definition } = mount();
    fireEvent.change(field(`${label}（文字色）`), { target: { value: "#0a0b0c" } });
    expect(definition().surfaces.header.light.text).toEqual({
      primary: "#334155",
      muted: "#64748b",
      link: "#147ba9",
      [key]: "#0a0b0c",
    });
  });

  it("没写完的颜色文本不进入草稿，预览也不会因为校验失败而塌掉", () => {
    const { definition } = mount();
    const fill = screen.getByTestId("theme-fill-solid-color");
    fireEvent.change(fill, { target: { value: "#12" } });
    expect(fill).toHaveAttribute("aria-invalid", "true");
    expect(definition()).toEqual(initialDefinition);
    expect(preview().style.getPropertyValue("--sf-header-bg")).toBe("#ffffff");
  });

  it.each([
    ["填充颜色", "#ffffff", "#111111"],
    ["遮罩颜色", "#010101", "#212121"],
    ["边框颜色", "#020202", "#313131"],
    ["正文（文字色）", "#030303", "#414141"],
    ["弱化文字（文字色）", "#040404", "#515151"],
    ["链接（文字色）", "#050505", "#616161"],
  ])("%s：没写完的文本不会跟到另一个档，切换后显示各自的值", (name, light, dark) => {
    mount({ initialDefinition: rich });
    fireEvent.change(field(name), { target: { value: "#12" } });
    expect(field(name)).toHaveAttribute("aria-invalid", "true");
    fireEvent.click(screen.getByRole("button", { name: "深色档" }));
    expect(field(name)).toHaveValue(dark);
    expect(field(name)).not.toHaveAttribute("aria-invalid");
    fireEvent.click(screen.getByRole("button", { name: "浅色档" }));
    expect(field(name)).toHaveValue(light);
    expect(field(name)).not.toHaveAttribute("aria-invalid");
  });

  it("改第 2 个色标的颜色，只动第 2 个", () => {
    const { definition } = mount();
    fireEvent.click(fillControls().getByRole("radio", { name: "线性渐变" }));
    fireEvent.change(fillControls().getByLabelText("填充色标 2 颜色"), {
      target: { value: "#0a0b0c" },
    });
    const fill = definition().surfaces.header.light.fill;
    if (fill?.type !== "linear") throw new Error("应为线性渐变");
    expect(fill.stops.map((stop) => stop.color)).toEqual(["#147ba9", "#0a0b0c"]);
  });

  it("删除色标后，没写完的颜色文本不会错位到别的色标上", () => {
    mount();
    fireEvent.click(fillControls().getByRole("radio", { name: "线性渐变" }));
    fireEvent.click(fillControls().getByRole("button", { name: "添加色标" }));
    const stop = (n: number) => fillControls().getByLabelText(`填充色标 ${n} 颜色`);
    fireEvent.change(stop(2), { target: { value: "#12" } });
    expect(stop(2)).toHaveAttribute("aria-invalid", "true");
    fireEvent.click(fillControls().getByRole("button", { name: "删除填充色标 1" }));
    expect(stop(1)).toHaveValue("#f6f3e7");
    expect(stop(2)).toHaveValue("#ffffff");
    expect(stop(2)).not.toHaveAttribute("aria-invalid");
  });
});

describe("ThemePackEditor：图片、内容插槽与素材库", () => {
  it("图片填充控件保持素材、位置、尺寸、重复、混合及不透明度", () => {
    const { definition } = mount();
    const controls = fillControls();
    fireEvent.click(controls.getByRole("radio", { name: "图片底纹" }));
    fireEvent.change(controls.getByLabelText("填充素材"), { target: { value: OTHER_FILE } });
    fireEvent.change(controls.getByRole("combobox", { name: "位置" }), {
      target: { value: "bottom center" },
    });
    fireEvent.change(controls.getByRole("combobox", { name: "尺寸" }), {
      target: { value: "50%" },
    });
    fireEvent.change(controls.getByRole("combobox", { name: "重复" }), {
      target: { value: "repeat-x" },
    });
    fireEvent.change(controls.getByRole("combobox", { name: "混合模式" }), {
      target: { value: "multiply" },
    });
    fireEvent.change(controls.getByRole("spinbutton", { name: "不透明度" }), {
      target: { value: "0.65" },
    });
    expect(definition().surfaces.header.light.fill).toEqual({
      type: "image",
      asset: OTHER_FILE,
      position: "bottom center",
      size: "50%",
      repeat: "repeat-x",
      blend: "multiply",
      opacity: 0.65,
    });
  });

  it("空素材库不允许新选图片，但现有图片填充仍可编辑", () => {
    const { unmount } = mount({ decorFiles: [] });
    expect(fillControls().getByRole("radio", { name: "图片底纹" })).toBeDisabled();
    expect(overlayControls().getByRole("radio", { name: "图片" })).toBeDisabled();
    expect(screen.getByText(/素材库还是空的/)).toBeInTheDocument();
    unmount();
    mount({
      decorFiles: [],
      initialDefinition: {
        surfaces: {
          header: {
            light: {
              fill: {
                type: "image",
                asset: FILE,
                position: "50% 50%",
                size: "cover",
                repeat: "no-repeat",
                blend: "normal",
                opacity: 1,
              },
            },
          },
        },
      },
    });
    expect(fillControls().getByRole("radio", { name: "图片底纹" })).toBeEnabled();
    expect(fillControls().getByRole("radio", { name: "图片底纹" })).toBeChecked();
  });

  it("素材库引用信息、底纹和内容图应用保持一致，预览图片保留原 URL/testid", () => {
    const { definition } = mount({
      decorUsage: new Map([
        [FILE, [{ packId: "default", packName: "默认主题", surfaceIds: ["header"] }]],
      ]),
    });
    const library = within(screen.getByTestId("theme-asset-library"));
    expect(library.getByText("被 1 个主题引用：默认主题（header）")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "板块卡片" }));
    fireEvent.click(library.getAllByRole("button", { name: "用作板块卡片底纹" })[0]);
    expect(screen.getByTestId("theme-preview-image")).toHaveAttribute(
      "src",
      `/brand/decor?file=${FILE}`,
    );
    expect(screen.getByTestId("theme-preview-image")).toHaveClass("size-full", "object-cover");
    expect(definition().surfaces["forum-band"].light.fill).toMatchObject({
      type: "image",
      asset: FILE,
    });
    fireEvent.click(screen.getByRole("button", { name: "主视觉" }));
    expect(library.queryByRole("button", { name: /底纹/ })).not.toBeInTheDocument();
    fireEvent.click(library.getAllByRole("button", { name: "用作内容图" })[1]);
    expect(definition().surfaces["hero-image"].light.contentSlot).toEqual({
      image: OTHER_FILE,
      imageHeightPx: 240,
    });
    expect(screen.getByRole("img", { name: "主视觉装饰图片预览" })).toHaveStyle({
      backgroundImage: "var(--sf-hero-image-content-image)",
    });
  });

  it("内容插槽沿用默认高度和清空语义，显式文字开关与已有高度不会被图片更新覆盖", () => {
    const { definition } = mount();
    const controls = within(screen.getByRole("group", { name: "内容插槽" }));
    expect(controls.getByRole("spinbutton", { name: "图片高度 px" })).toHaveValue(240);
    fireEvent.change(controls.getByLabelText("内容插槽素材"), { target: { value: FILE } });
    expect(definition().surfaces.header.light.contentSlot).toEqual({ image: FILE });
    fireEvent.change(controls.getByLabelText("内容插槽素材"), { target: { value: "" } });
    expect(definition().surfaces.header.light).not.toHaveProperty("contentSlot");
    fireEvent.change(controls.getByRole("spinbutton", { name: "图片高度 px" }), {
      target: { value: "320" },
    });
    fireEvent.click(controls.getByRole("checkbox", { name: "隐藏区域自有文字" }));
    expect(within(preview()).getByText("青翼字幕组")).toHaveStyle({ opacity: 0 });
    fireEvent.click(controls.getByRole("checkbox", { name: "隐藏区域自有文字" }));
    fireEvent.click(
      within(screen.getByTestId("theme-asset-library")).getAllByRole("button", {
        name: "用作内容图",
      })[0],
    );
    expect(definition().surfaces.header.light.contentSlot).toEqual({
      image: FILE,
      imageHeightPx: 320,
      hideText: false,
    });
  });
});

describe("ThemePackEditor：定义变更通知", () => {
  it("只在编辑定义后通知表单，模式切换和 surfaces 新引用均不触发初始写入", () => {
    const onDefinitionChange = vi.fn();
    const { rerender } = mount({ onDefinitionChange });
    expect(onDefinitionChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId("theme-fill-solid-color"), {
      target: { value: "#13579b" },
    });
    expect(onDefinitionChange).toHaveBeenCalledTimes(1);
    expect(onDefinitionChange.mock.calls[0][0].surfaces.header.light.fill.color).toBe("#13579b");
    rerender(
      <ThemePackEditor
        surfaces={[...surfaces]}
        initialDefinition={initialDefinition}
        decorFiles={[]}
        onDefinitionChange={onDefinitionChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "深色档" }));
    expect(onDefinitionChange).toHaveBeenCalledTimes(1);
  });
});

describe("ThemePackEditor：全站语义令牌接线", () => {
  const withTokens: ThemePackDefinition = {
    ...initialDefinition,
    tokens: {
      light: { colors: { primary: "#112233", ring: "#445566" }, radius: "md" },
      dark: { colors: { primary: "#aabbcc" } },
    },
  };
  const tokenPanel = () => screen.getByTestId("theme-token-editor") as HTMLDetailsElement;
  const openTokens = () => {
    tokenPanel().open = true;
  };
  const summary = () => tokenPanel().querySelector("summary")!;
  const primaryVar = () => preview().style.getPropertyValue("--primary");
  const hasTokens = (definition: ThemePackDefinition) => Object.hasOwn(definition, "tokens");

  it("版面顺序：颜色模式 → 浏览器与 PWA 颜色 → 全站语义令牌 → 区域按钮", () => {
    mount();
    const before = (a: Node, b: Node) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    const mode = screen.getByRole("group", { name: "颜色模式" });
    const pwa = screen.getByRole("group", { name: "浏览器与 PWA 颜色" });
    const region = screen.getByRole("button", { name: "顶栏" });
    expect(before(mode, pwa)).toBe(true);
    expect(before(pwa, tokenPanel())).toBe(true);
    expect(before(tokenPanel(), region)).toBe(true);
  });

  it("令牌面板默认收起", () => {
    mount();
    expect(tokenPanel().open).toBe(false);
  });

  it("没有编辑时，隐藏 definition 原样带着初始的令牌", () => {
    const { definition } = mount({ initialDefinition: withTokens });
    expect(definition()).toEqual(withTokens);
  });

  it("没有令牌的定义，编辑区域设置后也不会凭空出现 tokens", () => {
    const { definition } = mount();
    fireEvent.change(screen.getByTestId("theme-fill-solid-color"), {
      target: { value: "#778899" },
    });
    expect(hasTokens(definition())).toBe(false);
  });

  it("覆盖并修改一个全站颜色：写进隐藏 definition 的 tokens，每次编辑通知表单一次", () => {
    const onDefinitionChange = vi.fn();
    const { definition } = mount({ onDefinitionChange });
    openTokens();
    fireEvent.click(screen.getByRole("button", { name: "主色：覆盖" }));
    expect(definition().tokens).toEqual({ light: { colors: { primary: "#0e7490" } } });
    expect(onDefinitionChange).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByRole("textbox", { name: "主色（全站）" }), {
      target: { value: "#ABCDEF" },
    });
    expect(definition()).toEqual({
      ...initialDefinition,
      tokens: { light: { colors: { primary: "#abcdef" } } },
    });
    expect(onDefinitionChange).toHaveBeenCalledTimes(2);
    expect(onDefinitionChange.mock.calls[1][0]).toEqual(definition());
  });

  it("预览元素带着令牌变量，随浅 / 深档切换", () => {
    mount({ initialDefinition: withTokens });
    expect(primaryVar()).toBe("#112233");
    expect(preview().style.getPropertyValue("--ring")).toBe("#445566");
    expect(preview().style.getPropertyValue("--radius")).toBe("var(--fw-radius-md)");
    fireEvent.click(screen.getByRole("button", { name: "深色档" }));
    expect(primaryVar()).toBe("#aabbcc");
    expect(preview().style.getPropertyValue("--ring")).toBe("");
    expect(preview().style.getPropertyValue("--radius")).toBe("");
  });

  it("改全站颜色，预览立即用上新值", () => {
    mount();
    expect(primaryVar()).toBe("");
    openTokens();
    fireEvent.click(screen.getByRole("button", { name: "主色：覆盖" }));
    fireEvent.change(screen.getByRole("textbox", { name: "主色（全站）" }), {
      target: { value: "#13579b" },
    });
    expect(primaryVar()).toBe("#13579b");
  });

  it("基础定义里原有的令牌全部恢复继承后，隐藏 definition 里没有 tokens 键，之后改别的也不会复活", () => {
    const { definition } = mount({
      initialDefinition: {
        ...initialDefinition,
        tokens: { light: { colors: { primary: "#112233" } } },
      },
    });
    openTokens();
    fireEvent.click(screen.getByRole("button", { name: "主色：恢复继承" }));
    expect(hasTokens(definition())).toBe(false);
    expect(definition()).toEqual(initialDefinition);
    fireEvent.change(screen.getByTestId("theme-fill-solid-color"), {
      target: { value: "#778899" },
    });
    fireEvent.change(screen.getByLabelText("浏览器主题色"), { target: { value: "#112233" } });
    expect(hasTokens(definition())).toBe(false);
    expect(primaryVar()).toBe("");
  });

  it("只改区域设置或 PWA 时，令牌原样保留", () => {
    const { definition } = mount({ initialDefinition: withTokens });
    fireEvent.change(screen.getByTestId("theme-fill-solid-color"), {
      target: { value: "#778899" },
    });
    fireEvent.change(screen.getByLabelText("PWA 背景色"), { target: { value: "#445566" } });
    expect(definition().tokens).toEqual(withTokens.tokens);
  });

  it("深色档启用深色令牌：definition 里只新增空的 dark 集，浅色档的令牌不变", () => {
    const { definition } = mount({
      initialDefinition: { ...initialDefinition, tokens: { light: { radius: "md" } } },
    });
    fireEvent.click(screen.getByRole("button", { name: "深色档" }));
    openTokens();
    expect(summary()).toHaveTextContent("深色未启用");
    fireEvent.click(screen.getByRole("button", { name: "启用深色令牌" }));
    expect(definition().tokens).toEqual({ light: { radius: "md" }, dark: {} });
    expect(summary()).toHaveTextContent("已覆盖 0 项");
  });

  it("没写完或越界的令牌输入不进入 definition，预览也不会塌成空白", () => {
    const shadow = { x: 0, y: 1, blur: 3, spread: 0, color: "#000000", alpha: 0.1 };
    const { definition } = mount({
      initialDefinition: {
        ...initialDefinition,
        tokens: { light: { colors: { primary: "#112233" }, shadows: { s1: shadow } } },
      },
    });
    openTokens();
    fireEvent.change(screen.getByRole("textbox", { name: "主色（全站）" }), {
      target: { value: "#ABCDEF" },
    });
    const saved = JSON.stringify(definition());
    fireEvent.change(screen.getByRole("textbox", { name: "阴影 1 模糊" }), {
      target: { value: "99" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "主色（全站）" }), {
      target: { value: "#12" },
    });
    expect(JSON.stringify(definition())).toBe(saved);
    expect(primaryVar()).toBe("#abcdef");
    expect(preview().style.getPropertyValue("--shadow-1")).toBe("0px 1px 3px 0px rgb(0 0 0 / 0.1)");
  });

  it("顶部的浅 / 深切换同时驱动令牌面板、区域控件与预览", () => {
    mount({ initialDefinition: withTokens });
    openTokens();
    expect(screen.getByRole("textbox", { name: "主色（全站）" })).toHaveValue("#112233");
    expect(screen.getByTestId("theme-fill-solid-color")).toHaveValue("#ffffff");
    expect(preview()).toHaveAttribute("data-mode", "light");
    fireEvent.click(screen.getByRole("button", { name: "深色档" }));
    expect(screen.getByRole("textbox", { name: "主色（全站）" })).toHaveValue("#aabbcc");
    expect(screen.getByTestId("theme-fill-solid-color")).toHaveValue("#111111");
    expect(preview()).toHaveAttribute("data-mode", "dark");
  });

  it("切换浅 / 深档本身不算编辑：不通知表单，definition 不变", () => {
    const onDefinitionChange = vi.fn();
    const { definition } = mount({ initialDefinition: withTokens, onDefinitionChange });
    fireEvent.click(screen.getByRole("button", { name: "深色档" }));
    fireEvent.click(screen.getByRole("button", { name: "浅色档" }));
    expect(onDefinitionChange).not.toHaveBeenCalled();
    expect(definition()).toEqual(withTokens);
  });
});

describe("ThemePackEditor：令牌预览与对比度检查（3d）", () => {
  const openTokens = () => {
    (screen.getByTestId("theme-token-editor") as HTMLDetailsElement).open = true;
  };
  const tokenPreview = () => screen.getByTestId("token-preview");
  const panel = () => screen.getByTestId("contrast-panel");

  it("令牌预览跟着草稿走，与区域预览用同一份令牌", () => {
    mount();
    openTokens();
    fireEvent.click(screen.getByRole("button", { name: "主色：覆盖" }));
    fireEvent.change(screen.getByRole("textbox", { name: "主色（全站）" }), {
      target: { value: "#13579B" },
    });
    expect(tokenPreview().style.getPropertyValue("--primary")).toBe("#13579b");
    expect(preview().style.getPropertyValue("--primary")).toBe("#13579b");
  });

  it("深色档没启用深色令牌：令牌预览与对比度检查不显示，区域预览照常", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "深色档" }));
    openTokens();
    expect(screen.queryByTestId("token-preview")).toBeNull();
    expect(screen.queryByTestId("contrast-panel")).toBeNull();
    expect(preview()).toHaveAttribute("data-mode", "dark");
  });

  it("对比度检查按当前档计算：浅色档正文近白有缺口，深色档全部达标", () => {
    mount({
      initialDefinition: {
        ...initialDefinition,
        tokens: { light: { colors: { foreground: "#f8fafc" } }, dark: {} },
      },
    });
    openTokens();
    expect(within(panel()).getByText(/^5 项未达标，共 23 项/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "深色档" }));
    expect(within(panel()).getByText("23 项全部达标（≥ 4.5:1）")).toBeInTheDocument();
  });
});
