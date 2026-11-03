import { describe, expect, it } from "vitest";
import { themeSurfaceStyle } from "./surface-style";

describe("themeSurfaceStyle", () => {
  it("为区域变量生成安全的 legacy fallback", () => {
    expect(
      themeSurfaceStyle("header", {
        background: "var(--header-bg)",
        borderColor: "var(--header-border)",
        borderWidth: "1px",
        blur: "var(--header-blur)",
      }),
    ).toMatchObject({
      "--fw-surface-bg": "var(--sf-header-bg, var(--header-bg))",
      "--fw-surface-bg-opacity": "var(--sf-header-bg-image-opacity, 1)",
      "--fw-surface-bg-blend-mode": "var(--sf-header-bg-blend-mode, normal)",
      "--fw-surface-overlay-bg": "var(--sf-header-overlay-bg, transparent)",
      "--fw-surface-border-width": "var(--sf-header-border-width, 1px)",
      "--fw-surface-blur": "var(--sf-header-blur, var(--header-blur))",
    });
  });
});
