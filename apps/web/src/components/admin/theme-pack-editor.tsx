"use client";

import { useMemo, useState, type CSSProperties } from "react";
import { renderPackCssVars } from "@/lib/theme/surface-render";
import { decorUrl } from "@/lib/theme/decor-url";
import { ThemeAssetLibrary, type AssetLibraryItem } from "@/components/admin/theme-asset-library";
import { BlendSelect, DecorAssetSelect } from "@/components/admin/theme-workspace-ui";
import type {
  FillSpec,
  GradientStop,
  OverlaySpec,
  SurfaceCapabilities,
  ThemePackDefinition,
  ThemePackPwa,
} from "@/lib/theme/surface-schema";

/** 主题包分区编辑器：草稿通过受限渲染器预览，并随外层表单提交 JSON。 */

type ImageFill = Extract<FillSpec, { type: "image" }>;
type ImageOverlaySpec = Extract<OverlaySpec, { type: "image" }>;
interface SurfaceDraft {
  light: SurfaceCapabilities;
  dark?: SurfaceCapabilities;
}

export interface SurfaceMeta {
  id: string;
  label: string;
  caps: readonly string[];
}

const DEFAULT_PWA: ThemePackPwa = { themeColor: "#0e7490", backgroundColor: "#f8fafc" };
const DEFAULT_STOP = { color: "#147ba9", alpha: 1, position: 0 };
const DEFAULT_STOP2 = { color: "#f6f3e7", alpha: 1, position: 100 };

function GradientAngleEditor({
  angle,
  onChange,
}: {
  angle: number;
  onChange: (angle: number) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      角度
      <input
        type="range"
        min={0}
        max={359}
        value={angle}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="w-10 text-xs tabular-nums">{angle}°</span>
    </label>
  );
}

function GradientStopsEditor({
  label,
  addLabel,
  stops,
  onChange,
}: {
  label: string;
  addLabel: string;
  stops: GradientStop[];
  onChange: (stops: GradientStop[]) => void;
}) {
  return (
    <div className="space-y-2">
      {stops.map((stop, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-xs text-muted-foreground">
            {label}色标 {index + 1}
          </span>
          <input
            aria-label={`${label}色标 ${index + 1} 颜色`}
            type="color"
            value={stop.color}
            onChange={(event) =>
              onChange(
                stops.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, color: event.target.value } : item,
                ),
              )
            }
            className="h-8 w-14 rounded border"
          />
          <label className="flex items-center gap-1 text-xs">
            透明度
            <input
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={stop.alpha}
              onChange={(event) =>
                onChange(
                  stops.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, alpha: Number(event.target.value) } : item,
                  ),
                )
              }
              className="w-16 rounded border bg-background px-1 py-0.5"
            />
          </label>
          <label className="flex items-center gap-1 text-xs">
            位置
            <input
              type="number"
              min={0}
              max={100}
              step={1}
              value={stop.position}
              onChange={(event) =>
                onChange(
                  stops.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, position: Number(event.target.value) } : item,
                  ),
                )
              }
              className="w-16 rounded border bg-background px-1 py-0.5"
            />
          </label>
          {stops.length > 2 && (
            <button
              type="button"
              aria-label={`删除${label}色标 ${index + 1}`}
              onClick={() => onChange(stops.filter((_, itemIndex) => itemIndex !== index))}
              className="rounded border px-2 py-1 text-xs hover:bg-accent"
            >
              删除
            </button>
          )}
        </div>
      ))}
      {stops.length < 8 && (
        <button
          type="button"
          onClick={() => onChange([...stops, { color: "#ffffff", alpha: 1, position: 100 }])}
          className="rounded border px-2 py-1 text-xs hover:bg-accent"
        >
          {addLabel}
        </button>
      )}
    </div>
  );
}

function defaultOverlayGradient(type: "linear" | "radial"): OverlaySpec {
  const stops = [
    { color: "#ffffff", alpha: 0, position: 0 },
    { color: "#ffffff", alpha: 1, position: 100 },
  ];
  return type === "linear"
    ? { type, angle: 105, stops, overlayOpacity: 1 }
    : { type, shape: "ellipse", stops, overlayOpacity: 1 };
}

function toDraft(
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

function definitionFromDraft(
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

export function ThemePackEditor({
  surfaces,
  initialDefinition,
  fallbackDefinition,
  decorFiles,
  decorUsage,
}: {
  surfaces: readonly SurfaceMeta[];
  initialDefinition: ThemePackDefinition;
  /** default 包定义：预览未配置的 Surface/档位时兜底，与 SSR 注入口径一致 */
  fallbackDefinition?: ThemePackDefinition;
  decorFiles: readonly { file: string; name: string }[];
  /** 素材被主题包引用的去向（徽标 + 删除保护提示） */
  decorUsage?: ReadonlyMap<string, AssetLibraryItem["usage"]>;
}) {
  const [draft, setDraft] = useState<Record<string, SurfaceDraft>>(() =>
    toDraft(initialDefinition, surfaces),
  );
  const [pwa, setPwa] = useState<ThemePackPwa>(() => initialDefinition.pwa ?? DEFAULT_PWA);
  const [active, setActive] = useState(surfaces[0]?.id ?? "header");
  const [mode, setMode] = useState<"light" | "dark">("light");
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const current = draft[active]?.[mode] ?? {};
  const activeSurface = surfaces.find((surface) => surface.id === active);
  const gradientFill =
    current.fill?.type === "linear" || current.fill?.type === "radial" ? current.fill : undefined;
  const imageFill = current.fill?.type === "image" ? current.fill : undefined;
  const overlayGradient =
    current.overlay?.type === "linear" || current.overlay?.type === "radial"
      ? current.overlay
      : undefined;
  const overlayImage = current.overlay?.type === "image" ? current.overlay : undefined;

  const setCap = <K extends keyof SurfaceCapabilities>(key: K, value: SurfaceCapabilities[K]) =>
    setDraft((previous) => {
      const entry = previous[active] ?? { light: {} };
      const updated = { ...(entry[mode] ?? {}), [key]: value } as SurfaceCapabilities;
      const next = mode === "light" ? { ...entry, light: updated } : { ...entry, dark: updated };
      return { ...previous, [active]: next };
    });

  const updateImageFill = (patch: Partial<ImageFill>) => {
    if (imageFill) setCap("fill", { ...imageFill, ...patch });
  };

  const updateContentSlot = (patch: Partial<NonNullable<SurfaceCapabilities["contentSlot"]>>) => {
    const next = { ...current.contentSlot, ...patch };
    if (!next.image && !next.imageHeightPx && next.hideText === undefined) {
      setCap("contentSlot", undefined);
    } else {
      setCap("contentSlot", next);
    }
  };

  const definition = useMemo(() => definitionFromDraft(draft, pwa), [draft, pwa]);
  const draftJson = useMemo(() => JSON.stringify(definition), [definition]);
  const previewVars = useMemo(
    () =>
      renderPackCssVars(definition, fallbackDefinition)[
        mode === "light" ? "root:light" : "root:dark"
      ],
    [definition, fallbackDefinition, mode],
  );
  const previewStyle = previewVars as CSSProperties;
  const activeLabel = activeSurface?.label ?? active;

  return (
    <div className="space-y-4">
      <input type="hidden" name="definition" value={draftJson} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section className="space-y-3" aria-label="主题区域设置">
          <fieldset className="flex flex-wrap gap-4 rounded-lg border bg-card p-3">
            <legend className="px-1 text-xs font-medium text-muted-foreground">
              浏览器与 PWA 颜色
            </legend>
            <label className="flex items-center gap-2 text-xs">
              浏览器主题色
              <input
                type="color"
                value={pwa.themeColor}
                onChange={(event) =>
                  setPwa((value) => ({ ...value, themeColor: event.target.value }))
                }
                className="h-8 w-14 rounded border"
              />
            </label>
            <label className="flex items-center gap-2 text-xs">
              PWA 背景色
              <input
                type="color"
                value={pwa.backgroundColor}
                onChange={(event) =>
                  setPwa((value) => ({ ...value, backgroundColor: event.target.value }))
                }
                className="h-8 w-14 rounded border"
              />
            </label>
          </fieldset>
          <div className="flex flex-wrap gap-1.5">
            {surfaces.map((surface) => (
              <button
                key={surface.id}
                type="button"
                onClick={() => setActive(surface.id)}
                aria-pressed={active === surface.id}
                className={`rounded-md border px-2.5 py-1 text-xs ${
                  active === surface.id ? "border-primary bg-accent" : "hover:bg-accent"
                }`}
              >
                {surface.label}
              </button>
            ))}
          </div>
          <div className="flex gap-2" role="group" aria-label="颜色模式">
            {(["light", "dark"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                onClick={() => setMode(value)}
                className={`rounded-md border px-2.5 py-1 text-xs ${
                  mode === value ? "border-primary bg-accent" : "hover:bg-accent"
                }`}
              >
                {value === "light" ? "浅色档" : "深色档"}
              </button>
            ))}
          </div>

          <div className="space-y-4 rounded-xl border bg-card p-4">
            {mode === "dark" && !draft[active]?.dark && (
              <p className="text-xs text-muted-foreground">
                当前区域尚无深色定义；留空时运行时回退到默认主题的深色样式。
              </p>
            )}
            {activeSurface?.caps.includes("fill") && (
              <fieldset className="space-y-3">
                <legend className="text-xs font-medium text-muted-foreground">背景填充</legend>
                <div className="flex flex-wrap gap-3">
                  {(["solid", "linear", "radial", "image"] as const).map((type) => (
                    <label key={type} className="flex items-center gap-1 text-sm">
                      <input
                        type="radio"
                        name={`fill-type-${active}-${mode}`}
                        disabled={
                          type === "image" &&
                          decorFiles.length === 0 &&
                          current.fill?.type !== "image"
                        }
                        checked={current.fill?.type === type}
                        onChange={() => {
                          if (type === "solid") setCap("fill", { type, color: "#f8fafc" });
                          if (type === "linear") {
                            setCap("fill", {
                              type,
                              angle: 120,
                              stops: [DEFAULT_STOP, DEFAULT_STOP2],
                            });
                          }
                          if (type === "radial") {
                            setCap("fill", {
                              type,
                              shape: "circle",
                              stops: [DEFAULT_STOP, DEFAULT_STOP2],
                            });
                          }
                          if (type === "image" && decorFiles[0]) {
                            setCap("fill", {
                              type,
                              asset: decorFiles[0].file,
                              position: "50% 50%",
                              size: "cover",
                              repeat: "no-repeat",
                              blend: "normal",
                              opacity: 1,
                            });
                          }
                        }}
                      />
                      {type === "solid"
                        ? "纯色"
                        : type === "linear"
                          ? "线性渐变"
                          : type === "radial"
                            ? "径向渐变"
                            : "图片底纹"}
                    </label>
                  ))}
                </div>

                {current.fill?.type === "solid" && (
                  <label className="flex items-center gap-2 text-sm">
                    颜色
                    <input
                      data-testid="theme-fill-solid-color"
                      type="color"
                      value={current.fill.color}
                      onChange={(event) =>
                        setCap("fill", { type: "solid", color: event.target.value })
                      }
                      className="h-8 w-16 rounded border"
                    />
                    <code className="text-xs text-muted-foreground">{current.fill.color}</code>
                  </label>
                )}

                {gradientFill && (
                  <div className="space-y-2">
                    {gradientFill.type === "linear" && (
                      <GradientAngleEditor
                        angle={gradientFill.angle}
                        onChange={(angle) => setCap("fill", { ...gradientFill, angle } as FillSpec)}
                      />
                    )}
                    <GradientStopsEditor
                      label="填充"
                      addLabel="添加色标"
                      stops={gradientFill.stops}
                      onChange={(stops) => setCap("fill", { ...gradientFill, stops })}
                    />
                  </div>
                )}

                {imageFill && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <DecorAssetSelect
                      ariaLabel="填充素材"
                      value={imageFill.asset}
                      decorFiles={decorFiles}
                      onChange={(asset) => updateImageFill({ asset })}
                    />
                    <label className="grid gap-1 text-xs">
                      位置
                      <select
                        value={imageFill.position}
                        onChange={(event) => updateImageFill({ position: event.target.value })}
                        className="rounded border bg-background px-2 py-1.5"
                      >
                        {[
                          "50% 50%",
                          "top left",
                          "top center",
                          "top right",
                          "center left",
                          "center center",
                          "center right",
                          "bottom left",
                          "bottom center",
                          "bottom right",
                        ].map((position) => (
                          <option key={position} value={position}>
                            {position}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="grid gap-1 text-xs">
                      尺寸
                      <select
                        value={imageFill.size}
                        onChange={(event) =>
                          updateImageFill({ size: event.target.value as ImageFill["size"] })
                        }
                        className="rounded border bg-background px-2 py-1.5"
                      >
                        {["cover", "contain", "auto", "25%", "50%", "75%", "100%"].map((size) => (
                          <option key={size} value={size}>
                            {size}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="grid gap-1 text-xs">
                      重复
                      <select
                        value={imageFill.repeat}
                        onChange={(event) =>
                          updateImageFill({ repeat: event.target.value as ImageFill["repeat"] })
                        }
                        className="rounded border bg-background px-2 py-1.5"
                      >
                        {["no-repeat", "repeat", "repeat-x", "repeat-y"].map((repeat) => (
                          <option key={repeat} value={repeat}>
                            {repeat}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="grid gap-1 text-xs">
                      混合模式
                      <select
                        value={imageFill.blend}
                        onChange={(event) =>
                          updateImageFill({ blend: event.target.value as ImageFill["blend"] })
                        }
                        className="rounded border bg-background px-2 py-1.5"
                      >
                        {[
                          "normal",
                          "multiply",
                          "screen",
                          "overlay",
                          "soft-light",
                          "luminosity",
                        ].map((blend) => (
                          <option key={blend} value={blend}>
                            {blend}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="grid gap-1 text-xs">
                      不透明度
                      <input
                        type="number"
                        min={0}
                        max={1}
                        step={0.05}
                        value={imageFill.opacity}
                        onChange={(event) =>
                          updateImageFill({ opacity: Number(event.target.value) })
                        }
                        className="rounded border bg-background px-2 py-1.5"
                      />
                    </label>
                  </div>
                )}
              </fieldset>
            )}

            {activeSurface?.caps.includes("overlay") && (
              <fieldset className="space-y-3 border-t pt-3">
                <legend className="text-xs font-medium text-muted-foreground">覆盖遮罩</legend>
                <div className="flex flex-wrap gap-3">
                  {(["none", "solid", "linear", "radial", "image"] as const).map((mode) => (
                    <label key={mode} className="flex items-center gap-1 text-sm">
                      <input
                        type="radio"
                        name={`overlay-type-${active}-${mode}`}
                        disabled={mode === "image" && decorFiles.length === 0}
                        checked={
                          mode === "none" ? !current.overlay : current.overlay?.type === mode
                        }
                        onChange={() => {
                          if (mode === "none") {
                            setCap("overlay", undefined);
                          } else if (mode === "solid") {
                            setCap("overlay", {
                              type: "solid",
                              color: "#ffffff",
                              overlayOpacity: 0.5,
                            });
                          } else if (mode === "image") {
                            setCap("overlay", {
                              type: "image",
                              asset: decorFiles[0]?.file ?? "",
                              position: "50% 50%",
                              size: "cover",
                              repeat: "no-repeat",
                              blend: "normal",
                              opacity: 1,
                              overlayOpacity: 1,
                            });
                          } else {
                            setCap("overlay", defaultOverlayGradient(mode));
                          }
                        }}
                      />
                      {mode === "none"
                        ? "无"
                        : mode === "solid"
                          ? "纯色"
                          : mode === "linear"
                            ? "线性渐变"
                            : mode === "radial"
                              ? "径向渐变"
                              : "图片"}
                    </label>
                  ))}
                </div>

                {current.overlay?.type === "solid" && (
                  <div className="flex flex-wrap items-center gap-4">
                    <label className="flex items-center gap-2 text-sm">
                      遮罩颜色
                      <input
                        type="color"
                        value={current.overlay.color}
                        onChange={(event) =>
                          setCap("overlay", {
                            ...current.overlay!,
                            color: event.target.value,
                          } as OverlaySpec)
                        }
                        className="h-8 w-14 rounded border"
                      />
                    </label>
                    <label className="flex items-center gap-2 text-xs">
                      不透明度
                      <input
                        type="number"
                        min={0}
                        max={1}
                        step={0.05}
                        value={current.overlay.overlayOpacity ?? 1}
                        onChange={(event) =>
                          setCap("overlay", {
                            ...current.overlay!,
                            overlayOpacity: Number(event.target.value),
                          } as OverlaySpec)
                        }
                        className="w-16 rounded border bg-background px-1 py-0.5"
                      />
                    </label>
                  </div>
                )}

                {overlayGradient && (
                  <div className="space-y-2">
                    {overlayGradient.type === "linear" && (
                      <GradientAngleEditor
                        angle={overlayGradient.angle}
                        onChange={(angle) =>
                          setCap("overlay", {
                            ...overlayGradient,
                            angle,
                            overlayOpacity: current.overlay?.overlayOpacity,
                          } as OverlaySpec)
                        }
                      />
                    )}
                    <GradientStopsEditor
                      label="遮罩"
                      addLabel="添加遮罩色标"
                      stops={overlayGradient.stops}
                      onChange={(stops) =>
                        setCap("overlay", {
                          ...overlayGradient,
                          stops,
                          overlayOpacity: current.overlay?.overlayOpacity,
                        } as OverlaySpec)
                      }
                    />
                    <label className="flex items-center gap-2 text-xs">
                      遮罩强度
                      <input
                        type="number"
                        min={0}
                        max={1}
                        step={0.01}
                        value={current.overlay?.overlayOpacity ?? 1}
                        onChange={(event) =>
                          setCap("overlay", {
                            ...overlayGradient,
                            overlayOpacity: Number(event.target.value),
                          } as OverlaySpec)
                        }
                        className="w-16 rounded border bg-background px-1 py-0.5"
                      />
                    </label>
                  </div>
                )}

                {current.overlay?.type === "image" && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <DecorAssetSelect
                      ariaLabel="遮罩素材"
                      value={overlayImage?.asset ?? ""}
                      decorFiles={decorFiles}
                      onChange={(asset) =>
                        setCap("overlay", { ...current.overlay!, asset } as OverlaySpec)
                      }
                    />
                    <label className="grid gap-1 text-xs">
                      遮罩位置
                      <select
                        aria-label="遮罩位置"
                        value={overlayImage?.position ?? "50% 50%"}
                        onChange={(event) =>
                          setCap("overlay", {
                            ...current.overlay!,
                            position: event.target.value,
                          } as OverlaySpec)
                        }
                        className="rounded border bg-background px-2 py-1.5"
                      >
                        {["50% 50%", "top left", "top right", "bottom left", "bottom right"].map(
                          (position) => (
                            <option key={position} value={position}>
                              {position}
                            </option>
                          ),
                        )}
                      </select>
                    </label>
                    <label className="grid gap-1 text-xs">
                      混合模式
                      <BlendSelect
                        ariaLabel="遮罩混合模式"
                        value={overlayImage?.blend ?? "normal"}
                        onChange={(blend) =>
                          setCap("overlay", {
                            ...overlayImage!,
                            blend: blend as ImageOverlaySpec["blend"],
                          } as OverlaySpec)
                        }
                      />
                    </label>
                    <label className="grid gap-1 text-xs">
                      图片不透明度
                      <input
                        type="number"
                        min={0}
                        max={1}
                        step={0.01}
                        value={overlayImage?.opacity ?? 1}
                        onChange={(event) =>
                          setCap("overlay", {
                            ...current.overlay!,
                            opacity: Number(event.target.value),
                          } as OverlaySpec)
                        }
                        className="rounded border bg-background px-2 py-1.5"
                      />
                    </label>
                  </div>
                )}
              </fieldset>
            )}

            {activeSurface?.caps.includes("contentSlot") && (
              <fieldset className="space-y-3 border-t pt-3">
                <legend className="text-xs font-medium text-muted-foreground">内容插槽</legend>
                <label className="grid gap-1 text-xs">
                  装饰图片
                  <select
                    aria-label="内容插槽素材"
                    value={current.contentSlot?.image ?? ""}
                    onChange={(event) =>
                      updateContentSlot({ image: event.target.value || undefined })
                    }
                    className="rounded border bg-background px-2 py-1.5"
                  >
                    <option value="">使用区域默认内容</option>
                    {decorFiles.map((file) => (
                      <option key={file.file} value={file.file}>
                        {file.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex flex-wrap items-center gap-4">
                  <label className="flex items-center gap-2 text-xs">
                    图片高度
                    <input
                      type="number"
                      min={120}
                      max={480}
                      step={10}
                      value={current.contentSlot?.imageHeightPx ?? 240}
                      onChange={(event) =>
                        updateContentSlot({ imageHeightPx: Number(event.target.value) })
                      }
                      className="w-20 rounded border bg-background px-2 py-1"
                    />
                    px
                  </label>
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={current.contentSlot?.hideText ?? false}
                      onChange={(event) => updateContentSlot({ hideText: event.target.checked })}
                    />
                    隐藏区域自有文字
                  </label>
                </div>
              </fieldset>
            )}

            {activeSurface?.caps.includes("border") && (
              <fieldset className="flex flex-wrap items-center gap-4 border-t pt-3">
                <legend className="text-xs font-medium text-muted-foreground">边框</legend>
                <label className="flex items-center gap-2 text-xs">
                  颜色
                  <input
                    type="color"
                    value={current.border?.color ?? "#e2e8f0"}
                    onChange={(event) =>
                      setCap("border", {
                        color: event.target.value,
                        width: current.border?.width ?? 1,
                        style: current.border?.style ?? "solid",
                      })
                    }
                    className="h-8 w-14 rounded border"
                  />
                </label>
                <label className="flex items-center gap-1 text-xs">
                  宽度
                  <input
                    type="number"
                    min={0}
                    max={3}
                    value={current.border?.width ?? 1}
                    onChange={(event) =>
                      setCap("border", {
                        color: current.border?.color ?? "#e2e8f0",
                        width: Number(event.target.value) as 0 | 1 | 2 | 3,
                        style: current.border?.style ?? "solid",
                      })
                    }
                    className="w-14 rounded border bg-background px-1 py-0.5"
                  />
                </label>
                <label className="flex items-center gap-1 text-xs">
                  样式
                  <select
                    value={current.border?.style ?? "solid"}
                    onChange={(event) =>
                      setCap("border", {
                        color: current.border?.color ?? "#e2e8f0",
                        width: current.border?.width ?? 1,
                        style: event.target.value as "solid" | "dashed",
                      })
                    }
                    className="rounded border bg-background px-2 py-1"
                  >
                    <option value="solid">实线</option>
                    <option value="dashed">虚线</option>
                  </select>
                </label>
              </fieldset>
            )}

            {activeSurface?.caps.includes("text") && (
              <fieldset className="flex flex-wrap gap-4 border-t pt-3">
                <legend className="text-xs font-medium text-muted-foreground">文字颜色</legend>
                {(
                  [
                    ["primary", "正文"],
                    ["muted", "弱化文字"],
                    ["link", "链接"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} className="flex items-center gap-2 text-xs">
                    {label}
                    <input
                      type="color"
                      value={current.text?.[key] ?? "#334155"}
                      onChange={(event) =>
                        setCap("text", {
                          primary: current.text?.primary ?? "#334155",
                          muted: current.text?.muted ?? "#64748b",
                          link: current.text?.link ?? "#147ba9",
                          [key]: event.target.value,
                        })
                      }
                      className="h-8 w-14 rounded border"
                    />
                  </label>
                ))}
              </fieldset>
            )}

            {activeSurface?.caps.includes("blur") && (
              <label className="flex items-center gap-2 border-t pt-3 text-xs">
                毛玻璃模糊
                <input
                  type="number"
                  min={0}
                  max={24}
                  value={current.blur ?? 0}
                  onChange={(event) => setCap("blur", Number(event.target.value))}
                  className="w-16 rounded border bg-background px-2 py-1"
                />
                px
              </label>
            )}
          </div>
        </section>

        <aside className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-muted-foreground">实时预览（未保存）</p>
            <div className="flex gap-1" role="group" aria-label="预览宽度">
              {(
                [
                  ["desktop", "桌面"],
                  ["mobile", "移动"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={device === value}
                  onClick={() => setDevice(value)}
                  className={`rounded border px-2 py-0.5 text-[11px] ${
                    device === value ? "border-primary bg-accent" : "hover:bg-accent"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="rounded-xl border bg-muted/40 p-3">
            <div
              data-testid="theme-preview"
              data-surface={active}
              data-mode={mode}
              className={`relative mx-auto overflow-hidden rounded-lg border bg-background transition-[width] ${
                device === "mobile" ? "w-[375px] max-w-full" : "w-full"
              }`}
              style={{
                ...previewStyle,
                borderColor: `var(--sf-${active}-border-color, var(--border))`,
                borderStyle:
                  `var(--sf-${active}-border-style, solid)` as CSSProperties["borderStyle"],
                borderWidth: `var(--sf-${active}-border-width, 1px)`,
                color: `var(--sf-${active}-text, var(--foreground))`,
                backdropFilter: `blur(var(--sf-${active}-blur, 0px))`,
              }}
            >
              <div
                aria-hidden="true"
                className="absolute inset-0"
                style={{
                  background: `var(--sf-${active}-bg, var(--card))`,
                  backgroundBlendMode:
                    `var(--sf-${active}-bg-blend-mode, normal)` as CSSProperties["backgroundBlendMode"],
                  opacity: `var(--sf-${active}-bg-image-opacity, 1)`,
                }}
              />
              <div
                aria-hidden="true"
                className="absolute inset-0"
                style={{
                  background: `var(--sf-${active}-overlay-bg, transparent)`,
                  backgroundBlendMode:
                    `var(--sf-${active}-overlay-bg-blend-mode, normal)` as CSSProperties["backgroundBlendMode"],
                  opacity: `calc(var(--sf-${active}-overlay-opacity, 1) * var(--sf-${active}-overlay-bg-image-opacity, 1))`,
                }}
              />
              <div className="relative">
                <ThemeSurfaceMock surface={active} label={activeLabel} caps={current} />
              </div>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            预览按真实组件结构渲染当前区域的草稿变量；保存后才会写入主题包配置。
          </p>
          <ThemeAssetLibrary
            items={decorFiles.map((file) => ({
              ...file,
              usage: decorUsage?.get(file.file) ?? [],
            }))}
            activeSurfaceId={active}
            activeSurfaceLabel={activeLabel}
            canUseAsFill={activeSurface?.caps.includes("fill") ?? false}
            canUseAsContent={activeSurface?.caps.includes("contentSlot") ?? false}
            onUseAsFill={(file) =>
              setCap("fill", {
                type: "image",
                asset: file,
                position: "50% 50%",
                size: "cover",
                repeat: "no-repeat",
                blend: "normal",
                opacity: 1,
              })
            }
            onUseAsContent={(file) =>
              setCap("contentSlot", {
                ...current.contentSlot,
                image: file,
                ...(current.contentSlot?.imageHeightPx ? {} : { imageHeightPx: 240 }),
              })
            }
          />
        </aside>
      </div>
    </div>
  );
}

/** 按真实前台组件结构渲染的 Surface 预览体（消费与实站相同的 --sf-* 变量） */
function ThemeSurfaceMock({
  surface,
  label,
  caps,
}: {
  surface: string;
  label: string;
  caps: SurfaceCapabilities;
}) {
  const hideText = caps.contentSlot?.hideText === true;
  switch (surface) {
    case "header":
      return (
        <div className="flex h-14 items-center gap-3 px-4">
          <span aria-hidden className="size-6 rounded bg-current/20" />
          <span className="text-sm font-semibold" style={{ opacity: hideText ? 0 : 1 }}>
            青翼字幕组
          </span>
          <nav aria-hidden className="ml-4 hidden gap-2 text-xs opacity-70 sm:flex">
            <span>首页</span>
            <span>板块</span>
            <span>动态</span>
          </nav>
          <span aria-hidden className="ml-auto size-6 rounded-full bg-current/15" />
        </div>
      );
    case "banner-announce":
      return (
        <div className="flex items-center justify-center gap-2 px-4 py-2 text-xs">
          <span style={{ opacity: hideText ? 0 : 1 }}>📢 欢迎来到 FunWind</span>
          <span aria-hidden className="ml-2 size-3 rounded-full bg-current/25" />
        </div>
      );
    case "forum-band":
      return (
        <div className="flex gap-3 p-3">
          <div
            aria-hidden={caps.fill?.type !== "image"}
            className="relative w-24 shrink-0 overflow-hidden rounded-md bg-cover bg-center"
            style={{
              backgroundImage: caps.fill?.type === "image" ? undefined : "var(--sf-forum-band-bg)",
              aspectRatio: "4 / 3",
            }}
          >
            {caps.fill?.type === "image" ? (
              // 图片底纹用真实 <img>：能直接验证取图链路（naturalWidth > 0），而不是只看 CSS 变量
              // eslint-disable-next-line @next/next/no-img-element -- 素材池公开路由缩略图
              <img
                src={decorUrl(caps.fill.asset)}
                alt=""
                className="size-full object-cover"
                data-testid="theme-preview-image"
              />
            ) : (
              <span className="grid h-full place-items-center text-2xl font-bold opacity-20">
                翼
              </span>
            )}
          </div>
          <div className="min-w-0 flex-1 py-1">
            <p className="truncate text-sm font-medium" style={{ opacity: hideText ? 0 : 1 }}>
              『演示区』板块卡片
            </p>
            <p
              className="mt-1 line-clamp-2 text-xs opacity-70"
              style={{ opacity: hideText ? 0 : undefined }}
            >
              左侧图区铺底纹，右侧文字区随主题换色。
            </p>
          </div>
        </div>
      );
    case "hero-brand":
      return (
        <div className="flex flex-col items-center gap-2 p-5 text-center">
          <span aria-hidden className="size-16 rounded-xl bg-current/15" />
          <span className="text-base font-bold" style={{ opacity: hideText ? 0 : 1 }}>
            青翼字幕组
          </span>
          <span className="text-xs opacity-70" style={{ opacity: hideText ? 0 : undefined }}>
            日语·ACG 情怀社区
          </span>
        </div>
      );
    case "hero-image":
      return (
        <div className="p-3">
          <div
            role="img"
            aria-label={`${label}装饰图片预览`}
            className="rounded-lg bg-cover bg-center"
            style={{
              backgroundImage: caps.contentSlot?.image
                ? `var(--sf-hero-image-content-image)`
                : undefined,
              height: `var(--sf-hero-image-content-image-height, 120px)`,
              backgroundColor: caps.contentSlot?.image ? undefined : "rgb(0 0 0 / 0.08)",
            }}
          >
            {!caps.contentSlot?.image && (
              <p className="grid h-full place-items-center text-xs opacity-60">
                在素材库选择内容图后这里显示
              </p>
            )}
          </div>
        </div>
      );
    case "tabbar":
      return (
        <div className="flex h-12 items-stretch border-t border-current/15 text-[10px]">
          {["首页", "板块", "发帖", "消息"].map((tab, index) => (
            <span
              key={tab}
              className={`flex flex-1 flex-col items-center justify-center gap-0.5 ${
                index === 0 ? "font-medium" : "opacity-70"
              }`}
            >
              <span aria-hidden className="size-3.5 rounded bg-current/25" />
              {tab}
            </span>
          ))}
        </div>
      );
    case "footer":
      return (
        <div className="space-y-2 px-5 py-4 text-xs">
          <p
            className="flex flex-wrap gap-3 opacity-90"
            style={{ opacity: hideText ? 0 : undefined }}
          >
            <span className="font-medium">友情链接</span>
            <span className="underline">旧站档案馆</span>
            <span className="underline">字幕组百科</span>
          </p>
          <p className="opacity-60" style={{ opacity: hideText ? 0 : undefined }}>
            © 青翼字幕组 · 页脚文字随主题换色
          </p>
        </div>
      );
    case "auth":
      return (
        <div className="p-4">
          <div className="rounded-lg border border-current/15 bg-background/40 p-4">
            <p className="text-center text-sm font-semibold" style={{ opacity: hideText ? 0 : 1 }}>
              登录
            </p>
            <div aria-hidden className="mt-3 space-y-2">
              <span className="block h-7 rounded border border-current/20" />
              <span className="block h-7 rounded border border-current/20" />
              <span className="block h-7 rounded bg-current/25" />
            </div>
          </div>
        </div>
      );
    default:
      return (
        <div className="space-y-3 p-4">
          <p className="text-xs opacity-70">{label} · 全局背景预览</p>
          <div aria-hidden className="h-16 rounded-lg border border-current/15 bg-current/5" />
          <div aria-hidden className="h-16 rounded-lg border border-current/15 bg-current/5" />
        </div>
      );
  }
}
