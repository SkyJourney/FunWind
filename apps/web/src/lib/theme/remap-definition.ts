import type { ThemePackDefinition } from "./surface-schema";

/**
 * 重映射主题包定义里的素材引用（M11.1 导入功能，M11.6 追加 tokens 保留）。
 *
 * 导入归档时，decor/logo 文件名会重新生成（哈希冲突时加后缀），definition 里的引用需要同步改写。
 * 本函数只改写 surfaces 里的素材引用（fill / overlay / contentSlot 的 asset / image 字段），
 * 其余顶层段（pwa / tokens / 未来新增段）原样保留：避免字段遗漏导致数据丢失（pwa 曾因此在导入时被擦除）。
 *
 * @param definition 已校验的主题包定义
 * @param fileMap 旧文件名 → 新文件名的映射表
 * @returns 新定义（surfaces 已改写，其余段不变）
 */
export function remapDefinitionAssets(
  definition: ThemePackDefinition,
  fileMap: ReadonlyMap<string, string>,
): ThemePackDefinition {
  return {
    ...definition,
    surfaces: Object.fromEntries(
      Object.entries(definition.surfaces).map(([id, entry]) => [
        id,
        {
          light: remapCapabilities(entry.light, fileMap),
          ...(entry.dark ? { dark: remapCapabilities(entry.dark, fileMap) } : {}),
        },
      ]),
    ),
  };
}

/** 重映射单个档位的能力容器里的素材引用 */
function remapCapabilities(
  caps: Record<string, unknown>,
  fileMap: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const remapped = { ...caps };
  const fill = caps.fill as Record<string, unknown> | undefined;
  if (fill?.type === "image" && typeof fill.asset === "string") {
    remapped.fill = { ...fill, asset: fileMap.get(fill.asset) ?? fill.asset };
  }
  const overlay = caps.overlay as Record<string, unknown> | undefined;
  if (overlay?.type === "image" && typeof overlay.asset === "string") {
    remapped.overlay = { ...overlay, asset: fileMap.get(overlay.asset) ?? overlay.asset };
  }
  const contentSlot = caps.contentSlot as Record<string, unknown> | undefined;
  if (contentSlot?.image && typeof contentSlot.image === "string") {
    remapped.contentSlot = {
      ...contentSlot,
      image: fileMap.get(contentSlot.image) ?? contentSlot.image,
    };
  }
  return remapped;
}
