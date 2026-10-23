import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "next-themes";
import { describe, expect, it } from "vitest";
import { ThemeSwitcher } from "./theme-switcher";

function renderSwitcher() {
  return render(
    <ThemeProvider attribute="data-theme" defaultTheme="light" enableSystem={false}>
      <ThemeSwitcher />
    </ThemeProvider>,
  );
}

describe("ThemeSwitcher", () => {
  it("渲染三个主题选项", () => {
    renderSwitcher();
    expect(screen.getByTitle("浅色")).toBeInTheDocument();
    expect(screen.getByTitle("暗色")).toBeInTheDocument();
    expect(screen.getByTitle("跟随系统")).toBeInTheDocument();
  });

  it("初始浅色为激活态", () => {
    renderSwitcher();
    expect(screen.getByTitle("浅色")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTitle("暗色")).toHaveAttribute("aria-pressed", "false");
  });

  it("点击暗色后激活态迁移", async () => {
    const user = userEvent.setup();
    renderSwitcher();
    await user.click(screen.getByTitle("暗色"));
    expect(screen.getByTitle("暗色")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTitle("浅色")).toHaveAttribute("aria-pressed", "false");
  });

  it("主题组具备无障碍标注", () => {
    renderSwitcher();
    expect(screen.getByRole("group", { name: "主题切换" })).toBeInTheDocument();
  });
});
