import type { CSSProperties } from "react";
import type { SurfaceId } from "./surface-schema";

export interface SurfaceFallback {
  background?: string;
  overlay?: string;
  borderColor?: string;
  borderWidth?: string;
  borderStyle?: string;
  text?: string;
  textMuted?: string;
  textLink?: string;
  blur?: string;
}

/** 为旧版 CSS 变量提供兜底，同时把统一 Surface 变量交给组件级图层消费。 */
export function themeSurfaceStyle(area: SurfaceId, fallback: SurfaceFallback = {}): CSSProperties {
  return {
    "--fw-surface-bg": `var(--sf-${area}-bg, ${fallback.background ?? "transparent"})`,
    "--fw-surface-bg-opacity": `var(--sf-${area}-bg-image-opacity, 1)`,
    "--fw-surface-bg-blend-mode": `var(--sf-${area}-bg-blend-mode, normal)`,
    "--fw-surface-overlay-bg": `var(--sf-${area}-overlay-bg, ${fallback.overlay ?? "transparent"})`,
    "--fw-surface-overlay-opacity": `var(--sf-${area}-overlay-opacity, 1)`,
    "--fw-surface-overlay-bg-blend-mode": `var(--sf-${area}-overlay-bg-blend-mode, normal)`,
    "--fw-surface-overlay-bg-image-opacity": `var(--sf-${area}-overlay-bg-image-opacity, 1)`,
    "--fw-surface-content-image": `var(--sf-${area}-content-image, none)`,
    "--fw-surface-content-image-height": `var(--sf-${area}-content-image-height, auto)`,
    "--fw-surface-content-hide-text": `var(--sf-${area}-content-hide-text, 0)`,
    "--fw-surface-border-color": `var(--sf-${area}-border-color, ${fallback.borderColor ?? "transparent"})`,
    "--fw-surface-border-width": `var(--sf-${area}-border-width, ${fallback.borderWidth ?? "0px"})`,
    "--fw-surface-border-style": `var(--sf-${area}-border-style, ${fallback.borderStyle ?? "solid"})`,
    "--fw-surface-text": `var(--sf-${area}-text, ${fallback.text ?? "inherit"})`,
    "--fw-surface-text-muted": `var(--sf-${area}-text-muted, ${fallback.textMuted ?? "var(--muted-foreground)"})`,
    "--fw-surface-text-link": `var(--sf-${area}-text-link, ${fallback.textLink ?? "inherit"})`,
    "--fw-surface-blur": `var(--sf-${area}-blur, ${fallback.blur ?? "0px"})`,
  } as CSSProperties;
}
