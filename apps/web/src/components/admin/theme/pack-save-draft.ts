import { parseThemePackDefinition, type ThemePackDefinition } from "@/lib/theme/surface-schema";
import { tokensSchema } from "@/lib/theme/token-schema";

export interface ThemePackSaveDraft {
  userId: number;
  packId: string;
  expectedRevision: number;
  name: string;
  description: string;
  definition: ThemePackDefinition;
}

export const EMPTY_THEME_PACK_DEFINITION: ThemePackDefinition = { surfaces: {} };

export function themePackSaveDraftKey(userId: number, packId: string): string {
  return `fw.theme-pack.draft.${userId}.${packId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasFields(
  value: unknown,
  fields: Record<string, "string" | "number" | "boolean">,
): boolean {
  return (
    isRecord(value) &&
    Object.entries(fields).every(
      ([key, type]) => typeof value[key] === type || (type === "number" && value[key] === null),
    )
  );
}

function isEditableCapabilities(value: Record<string, unknown>): boolean {
  for (const key of ["fill", "overlay"]) {
    const fill = value[key];
    if (fill === undefined) continue;
    if (!isRecord(fill) || typeof fill.type !== "string") return false;
    if (fill.type === "solid" && typeof fill.color !== "string") return false;
    if (
      fill.type === "image" &&
      !hasFields(fill, {
        asset: "string",
        position: "string",
        size: "string",
        repeat: "string",
        blend: "string",
        opacity: "number",
      })
    )
      return false;
    if (fill.type === "linear" || fill.type === "radial") {
      if (
        !Array.isArray(fill.stops) ||
        !fill.stops.every((stop) =>
          hasFields(stop, { color: "string", alpha: "number", position: "number" }),
        )
      )
        return false;
    }
  }
  if (value.blur !== undefined && value.blur !== null && typeof value.blur !== "number")
    return false;
  if (
    value.border !== undefined &&
    !hasFields(value.border, { color: "string", width: "number", style: "string" })
  )
    return false;
  if (
    value.text !== undefined &&
    !hasFields(value.text, { primary: "string", muted: "string", link: "string" })
  )
    return false;
  if (value.contentSlot !== undefined && !isRecord(value.contentSlot)) return false;
  return true;
}

/** 只验证用于编辑表单的结构；数值范围、空素材等服务端暂时拒绝的中间态无损保留。 */
export function parseThemePackSaveDraft(raw: string): ThemePackSaveDraft | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return null;
    if (
      !Number.isSafeInteger(value.userId) ||
      typeof value.packId !== "string" ||
      !Number.isSafeInteger(value.expectedRevision) ||
      (value.expectedRevision as number) < 1 ||
      typeof value.name !== "string" ||
      value.name.length > 60 ||
      typeof value.description !== "string" ||
      value.description.length > 200 ||
      !isRecord(value.definition) ||
      !isRecord(value.definition.surfaces)
    ) {
      return null;
    }
    if (
      value.definition.pwa !== undefined &&
      (!isRecord(value.definition.pwa) ||
        Object.values(value.definition.pwa).some((color) => typeof color !== "string"))
    ) {
      return null;
    }
    // 令牌编辑器的数字框与颜色框只提交合法值，所以编辑器写出的草稿里 tokens 一定通过 schema。
    // 通不过说明存储被改坏或 schema 收紧过：整份草稿按损坏处理（回到服务端内容并给出提示），
    // 而不是把一个预览会塌成空白、输入框会显示 undefined 的半残定义交给编辑器。
    if (
      value.definition.tokens !== undefined &&
      !tokensSchema.safeParse(value.definition.tokens).success
    ) {
      return null;
    }
    for (const entry of Object.values(value.definition.surfaces)) {
      if (!isRecord(entry)) return null;
      for (const mode of ["light", "dark"] as const) {
        if (
          entry[mode] !== undefined &&
          (!isRecord(entry[mode]) ||
            !isEditableCapabilities(entry[mode] as Record<string, unknown>))
        ) {
          return null;
        }
      }
    }
    return {
      userId: value.userId as number,
      packId: value.packId,
      expectedRevision: value.expectedRevision as number,
      name: value.name,
      description: value.description,
      definition: value.definition as ThemePackDefinition,
    };
  } catch {
    return null;
  }
}

/** 控件只用副本：JSON 将 NaN 序列化成 null，输入显示默认数值而不改写原始定义。 */
export function definitionForThemePackControls(
  definition: ThemePackDefinition,
): ThemePackDefinition {
  return JSON.parse(JSON.stringify(definition), (key, value: unknown) =>
    value === null &&
    [
      "angle",
      "alpha",
      "position",
      "opacity",
      "overlayOpacity",
      "width",
      "blur",
      "imageHeightPx",
    ].includes(key)
      ? 0
      : value,
  ) as ThemePackDefinition;
}

/** 唯一预览入口：Schema 无效的中间态不下发到受限渲染器。 */
export function definitionForThemePackPreview(
  definition: ThemePackDefinition,
): ThemePackDefinition {
  const parsed = parseThemePackDefinition(definition);
  return parsed.ok ? parsed.value : EMPTY_THEME_PACK_DEFINITION;
}

export function serializeThemePackSaveDraft(draft: ThemePackSaveDraft): string {
  return JSON.stringify(draft);
}
