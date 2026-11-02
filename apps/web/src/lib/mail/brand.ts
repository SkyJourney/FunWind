import { getSiteChrome } from "@/lib/chrome/site-chrome";
import { getThemeCatalog } from "@/lib/theme/catalog";
import { APP_URL, SITE_NAME, SITE_TAGLINE } from "@/lib/site";
import type { MailBrand } from "./types";

/** 默认主题色（与内置 default 包的 PWA themeColor 一致），目录不可用时的兜底 */
export const DEFAULT_ACCENT = "#0e7490";

/** 读不到站点配置时的品牌兜底；也是纯单测里模板的缺省品牌 */
export const FALLBACK_BRAND: MailBrand = {
  siteName: SITE_NAME,
  siteUrl: APP_URL,
  tagline: SITE_TAGLINE,
  accent: DEFAULT_ACCENT,
};

/**
 * 解析邮件品牌：站名 / 标语 / 对外地址来自站点身份配置（chrome TTL 缓存），
 * 主题色跟随全站默认主题包（目录 30s 缓存）。任何一步失败都退回兜底，永不抛错——
 * 品牌信息缺失不该让一封验证邮件发不出去。
 */
export async function getMailBrand(): Promise<MailBrand> {
  try {
    const chrome = await getSiteChrome();
    let accent = DEFAULT_ACCENT;
    try {
      const packs = await getThemeCatalog();
      const pack =
        packs.find((p) => p.id === chrome.themePack) ?? packs.find((p) => p.id === "default");
      if (pack?.themeColor) accent = pack.themeColor;
    } catch {
      // 目录读取失败：沿用默认主题色
    }
    return {
      siteName: chrome.identity.name || SITE_NAME,
      siteUrl: (chrome.identity.url || APP_URL).replace(/\/$/, ""),
      tagline: chrome.identity.tagline || SITE_TAGLINE,
      accent,
    };
  } catch {
    return FALLBACK_BRAND;
  }
}
