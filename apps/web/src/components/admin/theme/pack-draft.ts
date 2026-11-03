import type {
  OverlaySpec,
  SurfaceCapabilities,
  ThemePackDefinition,
  ThemePackPwa,
} from "@/lib/theme/surface-schema";

export interface SurfaceDraft {
  light: SurfaceCapabilities;
  dark?: SurfaceCapabilities;
}

export interface SurfaceMeta {
  id: string;
  label: string;
  caps: readonly string[];
}

export const DEFAULT_PWA: ThemePackPwa = {
  themeColor: "#0e7490",
  backgroundColor: "#f8fafc",
};
export const DEFAULT_STOP = { color: "#147ba9", alpha: 1, position: 0 };
export const DEFAULT_STOP2 = { color: "#f6f3e7", alpha: 1, position: 100 };

/** 新建遮罩渐变，保持默认角度、形状、色标和强度。 */
export function defaultOverlayGradient(type: "linear" | "radial"): OverlaySpec {
  const stops = [
    { color: "#ffffff", alpha: 0, position: 0 },
    { color: "#ffffff", alpha: 1, position: 100 },
  ];
  return type === "linear"
    ? { type, angle: 105, stops, overlayOpacity: 1 }
    : { type, shape: "ellipse", stops, overlayOpacity: 1 };
}

/** 只为编辑器展示的区域建立草稿，浅拷贝各档能力且不补写深色档。 */
export function toDraft(
  definition: ThemePackDefinition,
  surfaces: readonly SurfaceMeta[],
): Record<string, SurfaceDraft> {
  return Object.fromEntries(
    surfaces.map((surface) => {
      const entry = definition.surfaces[surface.id];
      return [
        surface.id,
        {
          light: { ...(entry?.light ?? {}) },
          ...(entry?.dark ? { dark: { ...entry.dark } } : {}),
        },
      ];
    }),
  );
}

/** 按现有提交口径省略空区域和空深色档，不清理能力中值为 undefined 的键。 */
export function definitionFromDraft(
  draft: Record<string, SurfaceDraft>,
  pwa: ThemePackPwa,
): ThemePackDefinition {
  return {
    pwa,
    surfaces: Object.fromEntries(
      Object.entries(draft).flatMap(([id, entry]) => {
        const light = entry.light ?? {};
        const dark = entry.dark ?? {};
        if (Object.keys(light).length === 0 && Object.keys(dark).length === 0) return [];
        return [[id, { light, ...(Object.keys(dark).length > 0 ? { dark } : {}) }]];
      }),
    ),
  };
}

/** 不可变更新当前区域的一档能力，保留另一档和其他区域的引用。 */
export function updateDraftCapability<K extends keyof SurfaceCapabilities>(
  draft: Record<string, SurfaceDraft>,
  surface: string,
  mode: "light" | "dark",
  key: K,
  value: SurfaceCapabilities[K],
): Record<string, SurfaceDraft> {
  const entry = draft[surface] ?? { light: {} };
  const updated = { ...(entry[mode] ?? {}), [key]: value } as SurfaceCapabilities;
  const next = mode === "light" ? { ...entry, light: updated } : { ...entry, dark: updated };
  return { ...draft, [surface]: next };
}

/** 合并内容插槽补丁；只有图片、高度和显式文字开关均为空时才移除能力。 */
export function updateContentSlot(
  current: SurfaceCapabilities["contentSlot"],
  patch: Partial<NonNullable<SurfaceCapabilities["contentSlot"]>>,
): SurfaceCapabilities["contentSlot"] {
  const next = { ...current, ...patch };
  return !next.image && !next.imageHeightPx && next.hideText === undefined ? undefined : next;
}
