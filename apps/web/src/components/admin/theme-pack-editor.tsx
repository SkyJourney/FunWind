"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { renderPackCssVars } from "@/lib/theme/surface-render";
import { parseThemePackDefinition } from "@/lib/theme/surface-schema";
import { ContentSlotEditor } from "@/components/admin/theme/content-slot-editor";
import {
  GradientAngleEditor,
  GradientStopsEditor,
} from "@/components/admin/theme/gradient-editors";
import {
  DEFAULT_PWA,
  DEFAULT_STOP,
  DEFAULT_STOP2,
  defaultOverlayGradient,
  definitionFromDraft,
  toDraft,
  updateContentSlot,
  updateDraftCapability,
  type SurfaceDraft,
  type SurfaceMeta,
} from "@/components/admin/theme/pack-draft";
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
  packId,
  restoreDraft,
  surfaces,
  initialDefinition,
  fallbackDefinition,
  decorFiles,
  decorUsage,
}: {
  /** 草稿本地档键的组成部分：同包的冲突恢复不串到别的包 */
  packId: string;
  /** 页面带错误参数（err）时为 true：挂载时恢复上次草稿；正常进入则清除旧档 */
  restoreDraft: boolean;
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

  // G-19（全项目审查实证）：保存冲突等服务端错误 redirect 回本页时，编辑器子树会被
  // 新 RSC 树整体重挂载（软导航存活但内存草稿全丢）。草稿随写 sessionStorage，
  // 带 err 参数重挂载时恢复——错误路径不得清空用户工作成果；正常进入/保存成功
  // 则清档，防止下次冲突误恢复过期草稿。
  const draftKey = `fw.theme-pack.draft.${packId}`;
  useEffect(() => {
    if (!restoreDraft) {
      try {
        sessionStorage.removeItem(draftKey);
      } catch {
        // 存储不可用（隐私模式等）时静默降级：草稿不落本地档，行为等同修复前
      }
      return;
    }
    try {
      const raw = sessionStorage.getItem(draftKey);
      if (!raw) return;
      const parsed = parseThemePackDefinition(JSON.parse(raw));
      if (!parsed.ok) return; // 坏档（手改/截断）不恢复，回退库内定义
      // 挂载时从 sessionStorage（外部系统）一次性同步草稿到 state：不能改惰性初始化——
      // SSR 预渲染无 sessionStorage，会产生 hydration mismatch
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDraft(toDraft(parsed.value, surfaces));
      setPwa(parsed.value.pwa ?? DEFAULT_PWA);
    } catch {
      // 坏 JSON 不恢复
    }
  }, [restoreDraft, draftKey, surfaces]);
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
    setDraft((previous) => updateDraftCapability(previous, active, mode, key, value));

  const updateImageFill = (patch: Partial<ImageFill>) => {
    if (imageFill) setCap("fill", { ...imageFill, ...patch });
  };

  const setContentSlot = (patch: Partial<NonNullable<SurfaceCapabilities["contentSlot"]>>) =>
    setCap("contentSlot", updateContentSlot(current.contentSlot, patch));

  const definition = useMemo(() => definitionFromDraft(draft, pwa), [draft, pwa]);
  const draftJson = useMemo(() => JSON.stringify(definition), [definition]);
  // G-19：草稿每次变化随写本地档。挂载首轮跳过——恢复 effect 的 setDraft 尚未提交，
  // 此时写入会把待恢复的草稿覆盖成库内初始值（dev StrictMode 双跑下必然发生）
  const skipFirstWriteRef = useRef(true);
  useEffect(() => {
    if (skipFirstWriteRef.current) {
      skipFirstWriteRef.current = false;
      return;
    }
    try {
      sessionStorage.setItem(draftKey, draftJson);
    } catch {
      // 超限/不可用时静默降级：仅失去冲突恢复能力，编辑与保存不受影响
    }
  }, [draftJson, draftKey]);
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
              <ContentSlotEditor
                contentSlot={current.contentSlot}
                decorFiles={decorFiles}
                onChange={setContentSlot}
              />
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
