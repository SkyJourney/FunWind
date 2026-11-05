import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThemePackEditor, type SurfaceMeta } from "@/components/admin/theme-pack-editor";
import { surfaceCapabilitiesSchema } from "@/lib/theme/surface-schema";
import { BASE_BAND, BASE_COLORS, BASE_SHADOWS, SHADOW_SLOTS } from "@/lib/theme/token-base";
import { COLOR_KEYS, bandSchema, shadowSchema, type TokenSet } from "@/lib/theme/token-schema";
import { describeIssue } from "./issue-text";
import { ThemeTokenEditor } from "./theme-token-editor";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

/**
 * 交叉核对：issue-text.ts 里有几处名字是写死的（品牌渐变的字段名、板块卡的开关名、能力的标题……），
 * 页面上给作者看的路径必须就是编辑器里这个控件的名字，否则作者按提示找不到地方。
 * 做法：拿翻译出来的名字，去真实渲染的编辑器里找对应的控件；找不到就红。
 */

/** 翻译结果里「全站令牌 · 浅色档 · 」之后、「：错」之前的那一段 */
const tokenTail = (path: string) =>
  describeIssue(`tokens.light.${path}: 错`)
    .replace(/^全站令牌 · 浅色档 · /, "")
    .replace(/：错$/, "");

const FULL: TokenSet = {
  colors: Object.fromEntries(COLOR_KEYS.map((key) => [key, BASE_COLORS.light[key]])),
  radius: "md",
  displayFont: "songti",
  shadows: BASE_SHADOWS.light,
  brandGradient: { angle: 135, from: "#112233", to: "#445566" },
  band: { ...BASE_BAND, maskColor: "#ffffff" },
};

function mountTokens() {
  render(<ThemeTokenEditor mode="light" tokens={{ light: FULL }} onChange={() => {}} />);
  (screen.getByTestId("theme-token-editor") as HTMLDetailsElement).open = true;
}

describe("路径翻译出来的名字就是令牌编辑器里控件的名字", () => {
  it("22 个颜色：文本框名是「<名字>（全站）」", () => {
    mountTokens();
    for (const key of COLOR_KEYS) {
      const label = tokenTail(`colors.${key}`).replace(/^颜色 · /, "");
      expect(
        screen.getByRole("textbox", { name: `${label}（全站）` }),
        `${key} → ${label}`,
      ).toBeInTheDocument();
    }
  });

  it("阴影的每个字段：名字去掉 ` · ` 换成空格", () => {
    mountTokens();
    for (const slot of SHADOW_SLOTS) {
      for (const field of Object.keys(shadowSchema.shape)) {
        const name = tokenTail(`shadows.${slot}.${field}`).replaceAll(" · ", " ");
        expect(screen.getByRole("textbox", { name }), name).toBeInTheDocument();
      }
    }
  });

  it("品牌渐变的三个字段", () => {
    mountTokens();
    for (const field of ["angle", "from", "to"]) {
      const name = tokenTail(`brandGradient.${field}`).replaceAll(" · ", " ");
      expect(screen.getByRole("textbox", { name }), name).toBeInTheDocument();
    }
  });

  it("板块卡：文本框、遮罩开关（没有 dim 的控件，文档里写明了）", () => {
    mountTokens();
    for (const field of Object.keys(bandSchema.shape)) {
      if (field === "dim") continue;
      const tail = tokenTail(`band.${field}`);
      if (field === "mask") {
        const name = tail.replace(/^板块卡 · /, "");
        expect(screen.getByRole("checkbox", { name }), name).toBeInTheDocument();
      } else {
        const name = tail.replaceAll(" · ", " ");
        expect(screen.getByRole("textbox", { name }), name).toBeInTheDocument();
      }
    }
  });

  it("圆角与展示字体：下拉框的名字", () => {
    mountTokens();
    expect(screen.getByRole("combobox", { name: tokenTail("radius") })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: tokenTail("displayFont") })).toBeInTheDocument();
  });
});

describe("路径翻译出来的名字就是区域编辑器里各分区的标题", () => {
  const surfaces: readonly SurfaceMeta[] = [
    {
      id: "header",
      label: "顶部导航",
      caps: ["fill", "overlay", "border", "blur", "text", "contentSlot"],
    },
  ];

  it("每种能力都能在编辑器里找到同名的分区或控件", () => {
    render(
      <ThemePackEditor
        surfaces={surfaces}
        initialDefinition={{ surfaces: { header: { light: {} } } }}
        decorFiles={[{ file: `decor-${"a".repeat(32)}.png`, name: "底纹" }]}
      />,
    );
    for (const capability of Object.keys(surfaceCapabilitiesSchema.shape)) {
      const label = describeIssue(`surfaces.header.light.${capability}: 错`)
        .replace(/^顶部导航 · 浅色档 · /, "")
        .replace(/：错$/, "");
      // 分区是带标题的 fieldset；毛玻璃模糊是一个带单位的 label（「毛玻璃模糊 px」），按包含匹配
      const found =
        screen.queryByRole("group", { name: label }) ??
        screen.queryByLabelText(label, { exact: false });
      expect(found, `${capability} → ${label}`).not.toBeNull();
    }
  });
});
