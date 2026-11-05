"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { renderPackCssVars } from "@/lib/theme/surface-render";
import {
  definitionForThemePackControls,
  definitionForThemePackPreview,
} from "./theme/pack-save-draft";
import { ContentSlotEditor } from "@/components/admin/theme/content-slot-editor";
import {
  GradientAngleEditor,
  GradientStopsEditor,
} from "@/components/admin/theme/gradient-editors";
import {
  DEFAULT_PWA,
  DEFAULT_STOP,
  DEFAULT_STOP2,
  DEFAULT_TEXT_COLORS,
  defaultOverlayGradient,
  definitionFromDraft,
  toDraft,
  updateContentSlot,
  updateDraftCapability,
  type SurfaceDraft,
  type SurfaceMeta,
} from "@/components/admin/theme/pack-draft";
import { ColorField } from "@/components/admin/theme/color-field";
import { ThemeSurfaceMock } from "@/components/admin/theme/surface-mock";

export type { SurfaceMeta } from "@/components/admin/theme/pack-draft";
import { ThemeAssetLibrary, type AssetLibraryItem } from "@/components/admin/theme-asset-library";
import { BlendSelect, DecorAssetSelect } from "@/components/admin/theme-workspace-ui";
import type {
  FillSpec,
  OverlaySpec,
  SurfaceCapabilities,
  ThemePackDefinition,
  ThemePackPwa,
} from "@/lib/theme/surface-schema";

/** 主题包分区编辑器：草稿通过受限渲染器预览，并随外层表单提交 JSON。 */

type ImageFill = Extract<FillSpec, { type: "image" }>;
type ImageOverlaySpec = Extract<OverlaySpec, { type: "image" }>;

export function ThemePackEditor({
  surfaces,
  initialDefinition,
  fallbackDefinition,
  decorFiles,
  decorUsage,
  onDefinitionChange,
}: {
  /** 表单统一暂存名称、说明、定义及原始版本；编辑器只报告已提交到视图的定义变化。 */
  onDefinitionChange?: (definition: ThemePackDefinition) => void;
  surfaces: readonly SurfaceMeta[];
  initialDefinition: ThemePackDefinition;
  /** default 包定义：预览未配置的 Surface/档位时兜底，与 SSR 注入口径一致 */
  fallbackDefinition?: ThemePackDefinition;
  decorFiles: readonly { file: string; name: string }[];
  /** 素材被主题包引用的去向（徽标 + 删除保护提示） */
  decorUsage?: ReadonlyMap<string, AssetLibraryItem["usage"]>;
}) {
  const [draft, setDraft] = useState<Record<string, SurfaceDraft>>(() =>
    toDraft(definitionForThemePackControls(initialDefinition), surfaces),
  );
  const [pwa, setPwa] = useState<ThemePackPwa>(() => initialDefinition.pwa ?? DEFAULT_PWA);
  const [active, setActive] = useState(surfaces[0]?.id ?? "header");
  const [mode, setMode] = useState<"light" | "dark">("light");
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const current = draft[active]?.[mode] ?? {};

  const [edited, setEdited] = useState(false);
  const [baseDefinition] = useState(initialDefinition);
  const activeSurface = surfaces.find((surface) => surface.id === active);
  const gradientFill =
    current.fill?.type === "linear" || current.fill?.type === "radial" ? current.fill : undefined;
  const imageFill = current.fill?.type === "image" ? current.fill : undefined;
  const overlayGradient =
    current.overlay?.type === "linear" || current.overlay?.type === "radial"
      ? current.overlay
      : undefined;
  const overlayImage = current.overlay?.type === "image" ? current.overlay : undefined;

  const setCap = <K extends keyof SurfaceCapabilities>(key: K, value: SurfaceCapabilities[K]) => {
    setEdited(true);
    setDraft((previous) => updateDraftCapability(previous, active, mode, key, value));
  };

  const updatePwa = (key: keyof ThemePackPwa, value: string) => {
    setEdited(true);
    setPwa((previous) => ({ ...previous, [key]: value }));
  };

  const updateImageFill = (patch: Partial<ImageFill>) => {
    if (imageFill) setCap("fill", { ...imageFill, ...patch });
  };

  const setContentSlot = (patch: Partial<NonNullable<SurfaceCapabilities["contentSlot"]>>) =>
    setCap("contentSlot", updateContentSlot(current.contentSlot, patch));

  const editedDefinition = useMemo(() => definitionFromDraft(draft, pwa), [draft, pwa]);
  const definition = useMemo(
    () =>
      edited
        ? {
            ...baseDefinition,
            ...editedDefinition,
            surfaces: { ...baseDefinition.surfaces, ...editedDefinition.surfaces },
          }
        : baseDefinition,
    [edited, editedDefinition, baseDefinition],
  );
  const draftJson = useMemo(() => JSON.stringify(definition), [definition]);
  const safePreviewDefinition = useMemo(
    () => definitionForThemePackPreview(definition),
    [definition],
  );
  const previewCapabilities = safePreviewDefinition.surfaces[active]?.[mode] ?? {};
  useEffect(() => {
    if (edited) onDefinitionChange?.(definition);
  }, [definition, edited, onDefinitionChange]);
  const previewVars = useMemo(
    () =>
      renderPackCssVars(safePreviewDefinition, fallbackDefinition)[
        mode === "light" ? "root:light" : "root:dark"
      ],
    [safePreviewDefinition, fallbackDefinition, mode],
  );
  const previewStyle = previewVars as CSSProperties;
  const activeLabel = activeSurface?.label ?? active;

  return (
    <div className="max-w-full min-w-0 space-y-4">
      <input type="hidden" name="definition" value={draftJson} />
      <div className="grid max-w-full min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section className="max-w-full min-w-0 space-y-3" aria-label="主题区域设置">
          <fieldset className="flex max-w-full min-w-0 flex-wrap gap-4 rounded-lg border bg-card p-3">
            <legend className="px-1 text-xs font-medium text-muted-foreground">
              浏览器与 PWA 颜色
            </legend>
            <label className="flex items-start gap-2 text-xs">
              <span className="shrink-0 pt-2">浏览器主题色</span>
              <ColorField
                label="浏览器主题色"
                value={pwa.themeColor}
                onChange={(hex) => updatePwa("themeColor", hex)}
              />
            </label>
            <label className="flex items-start gap-2 text-xs">
              <span className="shrink-0 pt-2">PWA 背景色</span>
              <ColorField
                label="PWA 背景色"
                value={pwa.backgroundColor}
                onChange={(hex) => updatePwa("backgroundColor", hex)}
              />
            </label>
          </fieldset>
          <div className="flex max-w-full min-w-0 flex-wrap gap-1.5">
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
          <div className="flex min-w-0 flex-wrap gap-2" role="group" aria-label="颜色模式">
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

          <div className="max-w-full min-w-0 space-y-4 rounded-xl border bg-card p-3 sm:p-4">
            {mode === "dark" && !draft[active]?.dark && (
              <p className="text-xs text-muted-foreground">
                当前区域尚无深色定义；留空时运行时回退到默认主题的深色样式。
              </p>
            )}
            {activeSurface?.caps.includes("fill") && (
              <fieldset className="max-w-full min-w-0 space-y-3">
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
                  <label className="flex items-start gap-2 text-sm">
                    <span className="shrink-0 pt-1.5">颜色</span>
                    <ColorField
                      key={`fill:${active}:${mode}`}
                      testId="theme-fill-solid-color"
                      label="填充颜色"
                      value={current.fill.color}
                      onChange={(hex) => setCap("fill", { type: "solid", color: hex })}
                    />
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
                  <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
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
              <fieldset className="max-w-full min-w-0 space-y-3 border-t pt-3">
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
                    <label className="flex items-start gap-2 text-sm">
                      <span className="shrink-0 pt-1.5">遮罩颜色</span>
                      <ColorField
                        key={`overlay:${active}:${mode}`}
                        label="遮罩颜色"
                        value={current.overlay.color}
                        onChange={(hex) =>
                          setCap("overlay", { ...current.overlay!, color: hex } as OverlaySpec)
                        }
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
                  <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
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
              <ContentSlotEditor
                contentSlot={current.contentSlot}
                decorFiles={decorFiles}
                onChange={setContentSlot}
              />
            )}

            {activeSurface?.caps.includes("border") && (
              <fieldset className="flex flex-wrap items-center gap-4 border-t pt-3">
                <legend className="text-xs font-medium text-muted-foreground">边框</legend>
                <label className="flex items-start gap-2 text-xs">
                  <span className="shrink-0 pt-2">颜色</span>
                  <ColorField
                    key={`border:${active}:${mode}`}
                    label="边框颜色"
                    value={current.border?.color ?? "#e2e8f0"}
                    onChange={(hex) =>
                      setCap("border", {
                        color: hex,
                        width: current.border?.width ?? 1,
                        style: current.border?.style ?? "solid",
                      })
                    }
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
                  <label key={key} className="flex items-start gap-2 text-xs">
                    <span className="shrink-0 pt-2">{label}</span>
                    <ColorField
                      key={`text:${key}:${active}:${mode}`}
                      label={`${label}（文字色）`}
                      value={current.text?.[key] ?? DEFAULT_TEXT_COLORS[key]}
                      onChange={(hex) =>
                        setCap("text", {
                          primary: current.text?.primary ?? DEFAULT_TEXT_COLORS.primary,
                          muted: current.text?.muted ?? DEFAULT_TEXT_COLORS.muted,
                          link: current.text?.link ?? DEFAULT_TEXT_COLORS.link,
                          [key]: hex,
                        })
                      }
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

        <aside className="max-w-full min-w-0 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-muted-foreground">实时预览（未保存）</p>
            <div className="flex min-w-0 flex-wrap gap-1" role="group" aria-label="预览宽度">
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
                <ThemeSurfaceMock surface={active} label={activeLabel} caps={previewCapabilities} />
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
