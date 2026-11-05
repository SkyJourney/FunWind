import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThemePackDefinition } from "@/lib/theme/surface-schema";
import { BASE_BAND, BASE_COLORS, BASE_SHADOWS, type ColorMode } from "@/lib/theme/token-base";
import { COLOR_KEYS, tokensSchema } from "@/lib/theme/token-schema";
import { ThemeTokenEditor } from "./theme-token-editor";
import { COLOR_GROUPS, SHADOW_LABELS } from "./token-draft";

type Tokens = ThemePackDefinition["tokens"];

/** 每次渲染后的令牌快照；用例结束时统一校验它们都合法 */
let history: Tokens[] = [];
const current = () => history.at(-1);

beforeEach(() => {
  history = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const tokens of history) {
    if (tokens === undefined) continue;
    expect(tokensSchema.safeParse(tokens).success, JSON.stringify(tokens)).toBe(true);
    // 对象形状要与 JSON 往返一致：不能带值为 undefined 的键
    expect(tokens).toStrictEqual(JSON.parse(JSON.stringify(tokens)));
  }
});

/** 带真实 setState 的外壳：编辑器收到的是 React 的 setter，函数式更新由 React 基于最新状态计算 */
function Harness({ initial, startMode = "light" }: { initial?: Tokens; startMode?: ColorMode }) {
  const [tokens, setTokens] = useState<Tokens>(initial);
  const [mode, setMode] = useState<ColorMode>(startMode);
  useEffect(() => {
    history.push(tokens);
  }, [tokens]);
  return (
    <>
      <button type="button" onClick={() => setMode((m) => (m === "light" ? "dark" : "light"))}>
        切换档
      </button>
      <ThemeTokenEditor mode={mode} tokens={tokens} onChange={setTokens} />
    </>
  );
}

function openPanel() {
  const details = screen.getByTestId("theme-token-editor") as HTMLDetailsElement;
  details.open = true;
  return details;
}

const click = (name: string) => userEvent.click(screen.getByRole("button", { name }));
const field = (name: string) => screen.getByRole("textbox", { name });
const summaryText = () =>
  screen.getByTestId("theme-token-editor").querySelector("summary")!.textContent;

const FULL_LIGHT: NonNullable<Tokens>["light"] = {
  colors: { primary: "#112233", ring: "#445566" },
  radius: "md",
  shadows: {
    s1: { x: 1, y: 2, blur: 3, spread: 4, color: "#112233", alpha: 0.5 },
    s2: { x: 0, y: 8, blur: 16, spread: 0, color: "#000000", alpha: 0.25 },
  },
  displayFont: "songti",
  brandGradient: { angle: 90, from: "#000000", to: "#ffffff" },
  band: { width: 8.5, angle: 90, fade: 0, dim: 1, mask: false, maskColor: "#fffdf4" },
};

describe("ThemeTokenEditor：外壳与摘要", () => {
  it("默认收起，摘要显示当前档已覆盖的项数", () => {
    render(<Harness />);
    expect((screen.getByTestId("theme-token-editor") as HTMLDetailsElement).open).toBe(false);
    expect(summaryText()).toContain("全站语义令牌");
    expect(summaryText()).toContain("已覆盖 0 项");
  });

  it("项数 = 颜色 + 阴影 + 圆角 + 字体 + 渐变 + 板块卡", () => {
    render(<Harness initial={{ light: FULL_LIGHT }} />);
    expect(summaryText()).toContain("已覆盖 8 项");
  });

  it("项数只数当前档", async () => {
    render(<Harness initial={{ light: FULL_LIGHT, dark: { radius: "xl" } }} />);
    expect(summaryText()).toContain("已覆盖 8 项");
    await click("切换档");
    expect(summaryText()).toContain("已覆盖 1 项");
  });

  it("点摘要展开 / 收起（浏览器原生行为）", async () => {
    render(<Harness />);
    const details = screen.getByTestId("theme-token-editor") as HTMLDetailsElement;
    await userEvent.click(details.querySelector("summary")!);
    expect(details.open).toBe(true);
    await userEvent.click(details.querySelector("summary")!);
    expect(details.open).toBe(false);
  });

  it("说明文字讲清楚作用范围与继承规则", () => {
    render(<Harness />);
    expect(screen.getByText(/整个站点/)).toBeInTheDocument();
    expect(screen.getByText(/没有覆盖的项继承默认主题/)).toBeInTheDocument();
  });
});

describe("ThemeTokenEditor：颜色", () => {
  it("四个分组，22 个颜色各占一行，都显示继承的基础值", () => {
    render(<Harness />);
    openPanel();
    for (const group of COLOR_GROUPS) {
      expect(screen.getByRole("group", { name: `颜色 · ${group.label}` })).toBeInTheDocument();
    }
    for (const { items } of COLOR_GROUPS) {
      for (const { key, label } of items) {
        const row = screen.getByRole("button", { name: `${label}：覆盖` }).parentElement!;
        expect(within(row).getByText(BASE_COLORS.light[key])).toBeInTheDocument();
      }
    }
    expect(screen.getAllByRole("button", { name: /：覆盖$/ }).length).toBeGreaterThanOrEqual(22);
  });

  it("点「覆盖」：从继承值开始，写入该键，按钮变成「恢复继承」", async () => {
    render(<Harness />);
    openPanel();
    await click("主色：覆盖");
    expect(current()).toStrictEqual({ light: { colors: { primary: BASE_COLORS.light.primary } } });
    expect(field("主色（全站）")).toHaveValue(BASE_COLORS.light.primary);
    expect(screen.getByRole("button", { name: "主色：恢复继承" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "主色：覆盖" })).toBeNull();
    expect(summaryText()).toContain("已覆盖 1 项");
  });

  it("改值：合法值提交（规范为小写），不合法值留在框里并提示，不进入令牌", async () => {
    render(<Harness initial={{ light: { colors: { primary: "#112233" } } }} />);
    openPanel();
    fireEvent.change(field("主色（全站）"), { target: { value: "#ABCDEF" } });
    expect(current()).toStrictEqual({ light: { colors: { primary: "#abcdef" } } });
    fireEvent.change(field("主色（全站）"), { target: { value: "#12" } });
    expect(current()).toStrictEqual({ light: { colors: { primary: "#abcdef" } } });
    expect(field("主色（全站）")).toHaveAttribute("aria-invalid", "true");
    expect(field("主色（全站）")).toHaveAccessibleDescription(/当前仍使用 #abcdef/);
  });

  it("「恢复继承」删除该键；最后一个覆盖删掉后整个 tokens 不存在", async () => {
    render(<Harness initial={{ light: { colors: { primary: "#112233", ring: "#445566" } } }} />);
    openPanel();
    await click("主色：恢复继承");
    expect(current()).toStrictEqual({ light: { colors: { ring: "#445566" } } });
    expect(Object.hasOwn(current()!.light!.colors!, "primary")).toBe(false);
    await click("焦点环：恢复继承");
    expect(current()).toBeUndefined();
    expect(summaryText()).toContain("已覆盖 0 项");
  });

  it("恢复继承后再覆盖，回到继承值，不是上一次的值", async () => {
    render(<Harness initial={{ light: { colors: { primary: "#112233" } } }} />);
    openPanel();
    await click("主色：恢复继承");
    await click("主色：覆盖");
    expect(field("主色（全站）")).toHaveValue(BASE_COLORS.light.primary);
  });

  it("只改一个键，其他覆盖与其他字段保持不变", async () => {
    render(<Harness initial={{ light: FULL_LIGHT }} />);
    openPanel();
    await click("成功色：覆盖");
    expect(current()?.light?.colors).toStrictEqual({
      ...FULL_LIGHT.colors,
      success: BASE_COLORS.light.success,
    });
    expect(current()?.light?.radius).toBe("md");
    expect(current()?.light?.band).toStrictEqual(FULL_LIGHT.band);
  });

  it("每个函数式更新都基于传入的上一个状态计算，而不是渲染时捕获的值", () => {
    const updates: Array<(previous: Tokens) => Tokens> = [];
    render(
      <ThemeTokenEditor
        mode="light"
        tokens={undefined}
        onChange={(update) => updates.push(update)}
      />,
    );
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: "主色：覆盖" }));
    fireEvent.click(screen.getByRole("button", { name: "成功色：覆盖" }));
    // 两次点击都发生在同一份（陈旧的）props 上：依次应用后两项都在
    const result = updates.reduce<Tokens>((previous, update) => update(previous), undefined);
    expect(result).toStrictEqual({
      light: {
        colors: { primary: BASE_COLORS.light.primary, success: BASE_COLORS.light.success },
      },
    });
  });

  it("切换浅 / 深档后，上一档没写完的文本不会留在输入框里", async () => {
    render(
      <Harness
        initial={{
          light: { colors: { primary: "#112233" } },
          dark: { colors: { primary: "#445566" } },
        }}
      />,
    );
    openPanel();
    fireEvent.change(field("主色（全站）"), { target: { value: "#12" } });
    expect(field("主色（全站）")).toHaveAttribute("aria-invalid", "true");
    await click("切换档");
    expect(field("主色（全站）")).toHaveValue("#445566");
    expect(field("主色（全站）")).not.toHaveAttribute("aria-invalid");
    await click("切换档");
    expect(field("主色（全站）")).toHaveValue("#112233");
  });
});

describe("ThemeTokenEditor：深色令牌", () => {
  it("深色档没有令牌：只显示说明与「启用深色令牌」，不显示任何可编辑项", async () => {
    render(<Harness initial={{ light: { radius: "md" } }} />);
    await click("切换档");
    openPanel();
    expect(summaryText()).toContain("深色未启用");
    expect(screen.getByText(/没有深色令牌/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "启用深色令牌" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "主色：覆盖" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "圆角" })).toBeNull();
  });

  it("浅色档不显示启用 / 关闭深色令牌", () => {
    render(<Harness />);
    openPanel();
    expect(screen.queryByRole("button", { name: /深色令牌/ })).toBeNull();
  });

  it("启用 = 创建空集，全部继承：不复制浅色档的值", async () => {
    render(<Harness initial={{ light: { colors: { primary: "#112233" } } }} />);
    await click("切换档");
    openPanel();
    await click("启用深色令牌");
    expect(current()).toStrictEqual({ light: { colors: { primary: "#112233" } }, dark: {} });
    expect(summaryText()).toContain("已覆盖 0 项");
    const row = screen.getByRole("button", { name: "主色：覆盖" }).parentElement!;
    expect(within(row).getByText(BASE_COLORS.dark.primary)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭深色令牌" })).toBeInTheDocument();
  });

  it("深色档的编辑只写深色集，浅色档原样", async () => {
    render(<Harness initial={{ light: { colors: { primary: "#112233" } }, dark: {} }} />);
    await click("切换档");
    openPanel();
    await click("成功色：覆盖");
    expect(current()).toStrictEqual({
      light: { colors: { primary: "#112233" } },
      dark: { colors: { success: BASE_COLORS.dark.success } },
    });
  });

  it("深色档恢复到没有覆盖：保留空集（仍是「已启用」）", async () => {
    render(<Harness initial={{ dark: { colors: { primary: "#445566" } } }} startMode="dark" />);
    openPanel();
    await click("主色：恢复继承");
    expect(current()).toStrictEqual({ dark: {} });
    expect(screen.getByRole("button", { name: "关闭深色令牌" })).toBeInTheDocument();
  });

  it("关闭：没有覆盖时直接关，不弹确认", async () => {
    const confirm = vi.spyOn(window, "confirm");
    render(<Harness initial={{ light: { radius: "md" }, dark: {} }} startMode="dark" />);
    openPanel();
    await click("关闭深色令牌");
    expect(confirm).not.toHaveBeenCalled();
    expect(current()).toStrictEqual({ light: { radius: "md" } });
    expect(summaryText()).toContain("深色未启用");
  });

  it("关闭：已有覆盖时先确认，取消则什么都不变", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const initial = { dark: { colors: { primary: "#445566" }, radius: "xl" as const } };
    render(<Harness initial={initial} startMode="dark" />);
    openPanel();
    await click("关闭深色令牌");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]![0]).toContain("2 项");
    expect(current()).toStrictEqual(initial);
  });

  it("关闭：确认后整个深色集被删除，浅色档保留", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <Harness
        initial={{ light: { radius: "md" }, dark: { colors: { primary: "#445566" } } }}
        startMode="dark"
      />,
    );
    openPanel();
    await click("关闭深色令牌");
    expect(current()).toStrictEqual({ light: { radius: "md" } });
  });

  it("只有深色集、关闭后整个 tokens 不存在", async () => {
    render(<Harness initial={{ dark: {} }} startMode="dark" />);
    openPanel();
    await click("关闭深色令牌");
    expect(current()).toBeUndefined();
  });
});

describe("ThemeTokenEditor：圆角与展示字体", () => {
  it("默认继承：下拉停在「继承默认」，并写明继承的是哪一档", () => {
    render(<Harness />);
    openPanel();
    const radius = screen.getByRole("combobox", { name: "圆角" });
    expect(radius).toHaveValue("");
    expect(within(radius).getByRole("option", { name: "继承默认（大）" })).toBeInTheDocument();
    const font = screen.getByRole("combobox", { name: "展示字体" });
    expect(font).toHaveValue("");
    expect(
      within(font).getByRole("option", { name: "继承默认（系统无衬线）" }),
    ).toBeInTheDocument();
  });

  it("选一档写入，选回「继承默认」删除该键", async () => {
    render(<Harness />);
    openPanel();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "圆角" }), "md");
    expect(current()).toStrictEqual({ light: { radius: "md" } });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "展示字体" }), "songti");
    expect(current()).toStrictEqual({ light: { radius: "md", displayFont: "songti" } });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "圆角" }), "");
    expect(current()).toStrictEqual({ light: { displayFont: "songti" } });
    expect(Object.hasOwn(current()!.light!, "radius")).toBe(false);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "展示字体" }), "");
    expect(current()).toBeUndefined();
  });

  it("圆角的五档和字体的三档都可选，选「直角」是 none 而不是继承", async () => {
    render(<Harness />);
    openPanel();
    const radius = screen.getByRole("combobox", { name: "圆角" });
    expect(
      within(radius)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toStrictEqual(["继承默认（大）", "直角", "小", "中", "大", "特大"]);
    await userEvent.selectOptions(radius, "none");
    expect(current()).toStrictEqual({ light: { radius: "none" } });
    const font = screen.getByRole("combobox", { name: "展示字体" });
    expect(
      within(font)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toStrictEqual(["继承默认（系统无衬线）", "系统无衬线", "宋体", "衬线"]);
  });

  it("下拉显示已有的值", () => {
    render(<Harness initial={{ light: { radius: "xl", displayFont: "serif" } }} />);
    openPanel();
    expect(screen.getByRole("combobox", { name: "圆角" })).toHaveValue("xl");
    expect(screen.getByRole("combobox", { name: "展示字体" })).toHaveValue("serif");
  });
});

describe("ThemeTokenEditor：阴影", () => {
  it("三档按 1、2、3 的顺序排列", () => {
    render(<Harness />);
    openPanel();
    const names = screen
      .getAllByRole("button", { name: /^阴影 \d：覆盖$/ })
      .map((button) => button.getAttribute("aria-label"));
    expect(names).toStrictEqual(Object.values(SHADOW_LABELS).map((label) => `${label}：覆盖`));
  });

  it.each(["light", "dark"] as const)(
    "%s 档点「覆盖」：起点与基础层同值，六个字段都有值",
    async (mode) => {
      render(<Harness initial={mode === "dark" ? { dark: {} } : undefined} startMode={mode} />);
      openPanel();
      await click("阴影 1：覆盖");
      const base = BASE_SHADOWS[mode].s1;
      expect(current()?.[mode]?.shadows?.s1).toStrictEqual(base);
      expect(field("阴影 1 横向偏移")).toHaveValue(String(base.x));
      expect(field("阴影 1 纵向偏移")).toHaveValue(String(base.y));
      expect(field("阴影 1 模糊")).toHaveValue(String(base.blur));
      expect(field("阴影 1 扩展")).toHaveValue(String(base.spread));
      expect(field("阴影 1 不透明度")).toHaveValue(String(base.alpha));
      expect(field("阴影 1 颜色")).toHaveValue(base.color);
    },
  );

  it("改一个字段，其余字段与其他档保持不变", () => {
    render(<Harness initial={{ light: FULL_LIGHT }} />);
    openPanel();
    fireEvent.change(field("阴影 1 模糊"), { target: { value: "20" } });
    expect(current()?.light?.shadows?.s1).toStrictEqual({ ...FULL_LIGHT.shadows!.s1, blur: 20 });
    expect(current()?.light?.shadows?.s2).toStrictEqual(FULL_LIGHT.shadows!.s2);
    fireEvent.change(field("阴影 1 颜色"), { target: { value: "#ABCDEF" } });
    expect(current()?.light?.shadows?.s1?.color).toBe("#abcdef");
    fireEvent.change(field("阴影 1 不透明度"), { target: { value: "0.2" } });
    expect(current()?.light?.shadows?.s1?.alpha).toBe(0.2);
    fireEvent.change(field("阴影 1 横向偏移"), { target: { value: "-5" } });
    expect(current()?.light?.shadows?.s1?.x).toBe(-5);
  });

  it("越界或不合法的数不进入令牌，框里提示范围与当前仍使用的值", () => {
    render(<Harness initial={{ light: FULL_LIGHT }} />);
    openPanel();
    fireEvent.change(field("阴影 1 模糊"), { target: { value: "99" } });
    expect(current()?.light?.shadows?.s1?.blur).toBe(3);
    expect(field("阴影 1 模糊")).toHaveAttribute("aria-invalid", "true");
    expect(field("阴影 1 模糊")).toHaveAccessibleDescription("须为 0 到 80 的整数，当前仍使用 3");
    fireEvent.change(field("阴影 1 不透明度"), { target: { value: "1.5" } });
    expect(current()?.light?.shadows?.s1?.alpha).toBe(0.5);
    fireEvent.change(field("阴影 1 颜色"), { target: { value: "red" } });
    expect(current()?.light?.shadows?.s1?.color).toBe("#112233");
  });

  it("恢复继承删除该档；最后一档删掉后 shadows 一并消失", async () => {
    render(
      <Harness initial={{ light: { shadows: { s1: FULL_LIGHT.shadows!.s1 }, radius: "md" } }} />,
    );
    openPanel();
    await click("阴影 1：恢复继承");
    expect(current()).toStrictEqual({ light: { radius: "md" } });
    expect(Object.hasOwn(current()!.light!, "shadows")).toBe(false);
  });
});

describe("ThemeTokenEditor：品牌渐变", () => {
  it("点「覆盖」：135°，主色 → 强调底", async () => {
    render(<Harness />);
    openPanel();
    await click("品牌渐变：覆盖");
    expect(current()?.light?.brandGradient).toStrictEqual({
      angle: 135,
      from: BASE_COLORS.light.primary,
      to: BASE_COLORS.light.accent,
    });
  });

  it("起点跟随本档已覆盖的主色与强调底", async () => {
    render(<Harness initial={{ light: { colors: { primary: "#123456", accent: "#654321" } } }} />);
    openPanel();
    await click("品牌渐变：覆盖");
    expect(current()?.light?.brandGradient).toStrictEqual({
      angle: 135,
      from: "#123456",
      to: "#654321",
    });
  });

  it("三个字段分别可改；角度越界不进入令牌", () => {
    render(<Harness initial={{ light: { brandGradient: FULL_LIGHT.brandGradient } }} />);
    openPanel();
    fireEvent.change(field("品牌渐变 角度"), { target: { value: "270" } });
    fireEvent.change(field("品牌渐变 起点色"), { target: { value: "#AA0000" } });
    fireEvent.change(field("品牌渐变 终点色"), { target: { value: "#00BB00" } });
    expect(current()?.light?.brandGradient).toStrictEqual({
      angle: 270,
      from: "#aa0000",
      to: "#00bb00",
    });
    fireEvent.change(field("品牌渐变 角度"), { target: { value: "360" } });
    expect(current()?.light?.brandGradient?.angle).toBe(270);
    expect(field("品牌渐变 角度")).toHaveAttribute("aria-invalid", "true");
  });

  it("恢复继承删除渐变", async () => {
    render(<Harness initial={{ light: { brandGradient: FULL_LIGHT.brandGradient } }} />);
    openPanel();
    await click("品牌渐变：恢复继承");
    expect(current()).toBeUndefined();
  });
});

describe("ThemeTokenEditor：板块卡", () => {
  it("点「覆盖」：起点与基础层同值（含 dim，不含遮罩色）", async () => {
    render(<Harness />);
    openPanel();
    await click("板块卡：覆盖");
    expect(current()?.light?.band).toStrictEqual(BASE_BAND);
    expect(field("板块卡 图区宽度")).toHaveValue("7");
    expect(field("板块卡 遮罩角度")).toHaveValue("105");
    expect(field("板块卡 渐隐宽度")).toHaveValue("50");
    expect(screen.getByRole("checkbox", { name: "显示渐隐遮罩" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "指定遮罩色" })).not.toBeChecked();
    expect(screen.queryByRole("textbox", { name: "板块卡 遮罩色" })).toBeNull();
  });

  it("改宽度、角度、渐隐宽度；dim 与遮罩色原样保留", () => {
    render(<Harness initial={{ light: { band: FULL_LIGHT.band } }} />);
    openPanel();
    fireEvent.change(field("板块卡 图区宽度"), { target: { value: "10.25" } });
    fireEvent.change(field("板块卡 遮罩角度"), { target: { value: "45" } });
    fireEvent.change(field("板块卡 渐隐宽度"), { target: { value: "30" } });
    expect(current()?.light?.band).toStrictEqual({
      ...FULL_LIGHT.band,
      width: 10.25,
      angle: 45,
      fade: 30,
    });
    expect(current()?.light?.band?.dim).toBe(1);
    expect(current()?.light?.band?.maskColor).toBe("#fffdf4");
  });

  it("越界或不合法的数不进入令牌", () => {
    render(<Harness initial={{ light: { band: FULL_LIGHT.band } }} />);
    openPanel();
    fireEvent.change(field("板块卡 图区宽度"), { target: { value: "17" } });
    fireEvent.change(field("板块卡 遮罩角度"), { target: { value: "360" } });
    fireEvent.change(field("板块卡 渐隐宽度"), { target: { value: "50.5" } });
    expect(current()?.light?.band).toStrictEqual(FULL_LIGHT.band);
    for (const name of ["板块卡 图区宽度", "板块卡 遮罩角度", "板块卡 渐隐宽度"]) {
      expect(field(name)).toHaveAttribute("aria-invalid", "true");
    }
  });

  it("遮罩开关：关闭后出现「角度、渐隐宽度与遮罩色不生效」的提示", async () => {
    render(<Harness initial={{ light: { band: BASE_BAND } }} />);
    openPanel();
    expect(screen.queryByText(/遮罩关闭时/)).toBeNull();
    await userEvent.click(screen.getByRole("checkbox", { name: "显示渐隐遮罩" }));
    expect(current()?.light?.band?.mask).toBe(false);
    expect(screen.getByText(/遮罩关闭时/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "显示渐隐遮罩" }));
    expect(current()?.light?.band?.mask).toBe(true);
    expect(screen.queryByText(/遮罩关闭时/)).toBeNull();
  });

  it("指定遮罩色：从本档卡片底色开始；取消指定则删除该键，回到跟随卡片底色", async () => {
    render(<Harness initial={{ light: { band: BASE_BAND, colors: { card: "#fffdf4" } } }} />);
    openPanel();
    await userEvent.click(screen.getByRole("checkbox", { name: "指定遮罩色" }));
    expect(current()?.light?.band?.maskColor).toBe("#fffdf4");
    expect(field("板块卡 遮罩色")).toHaveValue("#fffdf4");
    fireEvent.change(field("板块卡 遮罩色"), { target: { value: "#00FF00" } });
    expect(current()?.light?.band?.maskColor).toBe("#00ff00");
    await userEvent.click(screen.getByRole("checkbox", { name: "指定遮罩色" }));
    expect(Object.hasOwn(current()!.light!.band!, "maskColor")).toBe(false);
    expect(screen.queryByRole("textbox", { name: "板块卡 遮罩色" })).toBeNull();
  });

  it("恢复继承删除整个板块卡覆盖", async () => {
    render(<Harness initial={{ light: { band: FULL_LIGHT.band } }} />);
    openPanel();
    await click("板块卡：恢复继承");
    expect(current()).toBeUndefined();
  });
});

describe("ThemeTokenEditor：展示细节", () => {
  const rowOf = (name: string) => screen.getByRole("button", { name }).parentElement!;

  it("三个区块的标题", () => {
    render(<Harness />);
    openPanel();
    for (const name of ["形状与字体", "阴影", "品牌渐变与板块卡"]) {
      expect(screen.getByRole("group", { name })).toBeInTheDocument();
    }
  });

  it("按钮上的可见文字：继承时是「覆盖」，覆盖后是「恢复继承」", async () => {
    render(<Harness />);
    openPanel();
    expect(screen.getByRole("button", { name: "主色：覆盖" })).toHaveTextContent(/^覆盖$/);
    await click("主色：覆盖");
    expect(screen.getByRole("button", { name: "主色：恢复继承" })).toHaveTextContent(/^恢复继承$/);
  });

  it("继承的颜色行：色块对读屏隐藏，底色就是基础值", () => {
    render(<Harness />);
    openPanel();
    const swatch = rowOf("主色：覆盖").querySelector<HTMLElement>('[aria-hidden="true"]');
    expect(swatch).not.toBeNull();
    expect(swatch).toHaveStyle({ backgroundColor: BASE_COLORS.light.primary });
  });

  it("改的是哪个颜色就写哪个键，不影响别的键", () => {
    render(<Harness initial={{ light: { colors: { primary: "#112233", ring: "#445566" } } }} />);
    openPanel();
    fireEvent.change(field("焦点环（全站）"), { target: { value: "#ABCDEF" } });
    expect(current()?.light?.colors).toStrictEqual({ primary: "#112233", ring: "#abcdef" });
  });

  it("单位跟在输入框后面", () => {
    render(<Harness initial={{ light: FULL_LIGHT }} />);
    openPanel();
    const unitOf = (name: string) => field(name).parentElement!.textContent;
    expect(unitOf("阴影 1 横向偏移")).toBe("px");
    expect(unitOf("阴影 1 模糊")).toBe("px");
    expect(unitOf("阴影 1 不透明度")).toBe("");
    expect(unitOf("品牌渐变 角度")).toBe("°");
    expect(unitOf("板块卡 图区宽度")).toBe("rem");
    expect(unitOf("板块卡 遮罩角度")).toBe("°");
    expect(unitOf("板块卡 渐隐宽度")).toBe("%");
  });

  it("整数框拒绝小数，下界之外的数也被拒绝", () => {
    render(<Harness initial={{ light: FULL_LIGHT }} />);
    openPanel();
    fireEvent.change(field("阴影 1 模糊"), { target: { value: "1.5" } });
    expect(field("阴影 1 模糊")).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(field("阴影 1 横向偏移"), { target: { value: "-65" } });
    expect(field("阴影 1 横向偏移")).toHaveAttribute("aria-invalid", "true");
    expect(current()?.light?.shadows?.s1).toStrictEqual(FULL_LIGHT.shadows!.s1);
  });

  it("继承时写明基础层的具体值", () => {
    render(<Harness />);
    openPanel();
    expect(rowOf("阴影 1：覆盖")).toHaveTextContent("偏移 0/1px，模糊 3px，不透明度 0.08");
    expect(rowOf("阴影 2：覆盖")).toHaveTextContent("偏移 0/4px，模糊 12px，不透明度 0.1");
    expect(rowOf("阴影 3：覆盖")).toHaveTextContent("偏移 0/12px，模糊 32px，不透明度 0.16");
    expect(rowOf("板块卡：覆盖")).toHaveTextContent(
      "图区 7rem，遮罩角度 105°，渐隐 50%，带渐隐遮罩",
    );
    expect(rowOf("品牌渐变：覆盖")).toHaveTextContent("半透明三色渐变");
  });

  it("已有阴影覆盖时，每一档的输入框显示的是自己的现值，而不是基础值", () => {
    render(<Harness initial={{ light: FULL_LIGHT }} />);
    openPanel();
    expect(field("阴影 1 横向偏移")).toHaveValue("1");
    expect(field("阴影 1 纵向偏移")).toHaveValue("2");
    expect(field("阴影 1 模糊")).toHaveValue("3");
    expect(field("阴影 1 扩展")).toHaveValue("4");
    expect(field("阴影 1 不透明度")).toHaveValue("0.5");
    expect(field("阴影 1 颜色")).toHaveValue("#112233");
    expect(field("阴影 2 横向偏移")).toHaveValue("0");
    expect(field("阴影 2 纵向偏移")).toHaveValue("8");
    expect(field("阴影 2 模糊")).toHaveValue("16");
    expect(field("阴影 2 扩展")).toHaveValue("0");
    expect(field("阴影 2 不透明度")).toHaveValue("0.25");
    expect(field("阴影 2 颜色")).toHaveValue("#000000");
  });

  it("改第 2 档只动第 2 档，第 1 档原样", () => {
    render(<Harness initial={{ light: FULL_LIGHT }} />);
    openPanel();
    fireEvent.change(field("阴影 2 颜色"), { target: { value: "#ABCDEF" } });
    fireEvent.change(field("阴影 2 模糊"), { target: { value: "24" } });
    expect(current()?.light?.shadows?.s2).toStrictEqual({
      ...FULL_LIGHT.shadows!.s2,
      color: "#abcdef",
      blur: 24,
    });
    expect(current()?.light?.shadows?.s1).toStrictEqual(FULL_LIGHT.shadows!.s1);
  });

  it("在表单里点任何按钮都不会提交表单（全部是 type=button）", async () => {
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Harness initial={{ light: FULL_LIGHT, dark: {} }} />
      </form>,
    );
    openPanel();
    for (const button of screen.getAllByRole("button")) {
      expect(button, button.textContent ?? "").toHaveAttribute("type", "button");
    }
    await click("成功色：覆盖");
    await click("阴影 3：覆盖");
    await click("切换档");
    await click("关闭深色令牌");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("已有渐变与板块卡覆盖时，输入框显示的是现值", () => {
    render(<Harness initial={{ light: FULL_LIGHT }} />);
    openPanel();
    expect(field("品牌渐变 角度")).toHaveValue("90");
    expect(field("品牌渐变 起点色")).toHaveValue("#000000");
    expect(field("品牌渐变 终点色")).toHaveValue("#ffffff");
    expect(field("板块卡 图区宽度")).toHaveValue("8.5");
    expect(field("板块卡 遮罩角度")).toHaveValue("90");
    expect(field("板块卡 渐隐宽度")).toHaveValue("0");
    expect(field("板块卡 遮罩色")).toHaveValue("#fffdf4");
    expect(screen.getByRole("checkbox", { name: "显示渐隐遮罩" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "指定遮罩色" })).toBeChecked();
  });

  it("深色档继承的阴影说明用深色基础值", () => {
    render(<Harness initial={{ dark: {} }} startMode="dark" />);
    openPanel();
    expect(rowOf("阴影 1：覆盖")).toHaveTextContent("偏移 0/1px，模糊 2px，不透明度 0.5");
  });

  it("深色档的渐变起点取深色基础色，遮罩色起点取深色卡片底", async () => {
    render(<Harness initial={{ dark: {} }} startMode="dark" />);
    openPanel();
    await click("品牌渐变：覆盖");
    expect(current()?.dark?.brandGradient).toStrictEqual({
      angle: 135,
      from: BASE_COLORS.dark.primary,
      to: BASE_COLORS.dark.accent,
    });
    await click("板块卡：覆盖");
    await userEvent.click(screen.getByRole("checkbox", { name: "指定遮罩色" }));
    expect(current()?.dark?.band?.maskColor).toBe(BASE_COLORS.dark.card);
  });
});

describe("ThemeTokenEditor：可访问名称", () => {
  it("全部覆盖展开后，所有按钮、输入框、下拉框、复选框的名称互不相同", () => {
    const colors = Object.fromEntries(COLOR_KEYS.map((key) => [key, BASE_COLORS.light[key]]));
    render(
      <Harness
        initial={{
          light: {
            ...FULL_LIGHT,
            colors,
            shadows: {
              s1: BASE_SHADOWS.light.s1,
              s2: BASE_SHADOWS.light.s2,
              s3: BASE_SHADOWS.light.s3,
            },
          },
        }}
      />,
    );
    openPanel();
    for (const role of ["button", "textbox", "combobox", "checkbox"] as const) {
      const names = screen.getAllByRole(role).map((element) => {
        // 可访问名称的取法：aria-label，其次是关联的 <label> 文字，最后是元素自身的文字
        const labelled = (element as HTMLInputElement).labels?.[0]?.textContent;
        return (element.getAttribute("aria-label") ?? labelled ?? element.textContent ?? "").trim();
      });
      expect(
        names.every((name) => name.length > 0),
        `${role} 有空名称`,
      ).toBe(true);
      expect(new Set(names).size, `${role} 重名：${names.join(" | ")}`).toBe(names.length);
    }
    // 22 个颜色 + 3 档阴影各 6 个 + 渐变 3 个 + 板块卡 3 个数字与 1 个遮罩色
    expect(screen.getAllByRole("textbox")).toHaveLength(22 + 18 + 3 + 3 + 1);
  });
});
