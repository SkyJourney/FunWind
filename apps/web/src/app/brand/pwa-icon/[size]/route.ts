import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { getSiteChrome } from "@/lib/chrome/site-chrome";
import { getThemeCatalog } from "@/lib/theme/catalog";
import { readLogoBytes } from "@/lib/brand/logo-pool-fs";

/**
 * PWA manifest 图标（M11）：优先使用 LOGO 池当前项（主题↔LOGO 联动后自动随包切换），
 * 无池项时回退 public/pwa 静态图标；运行时按 192/512/maskable-512 生成安全尺寸。
 * brand 路由不进 SW CacheStorage；浏览器 HTTP 缓存 5 分钟，切换 LOGO 后收敛。
 */
const SIZE_CONFIG = {
  "192": { size: 192, scale: 0.72, fallback: "icon-192.png" },
  "512": { size: 512, scale: 0.72, fallback: "icon-512.png" },
  "maskable-512": { size: 512, scale: 0.62, fallback: "icon-maskable-512.png" },
} as const;

type SizeKey = keyof typeof SIZE_CONFIG;

function rgbOf(hex: string): { r: number; g: number; b: number } {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return { r: 14, g: 116, b: 144 };
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  };
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ size: string }> },
): Promise<Response> {
  const { size: rawSize } = await params;
  if (!(rawSize in SIZE_CONFIG)) return new Response(null, { status: 404 });
  const key = rawSize as SizeKey;
  const config = SIZE_CONFIG[key];
  const [logo, chrome, catalog] = await Promise.all([
    readLogoBytes(),
    getSiteChrome(),
    getThemeCatalog(),
  ]);
  const themeColor = catalog.find((pack) => pack.id === chrome.themePack)?.themeColor ?? "#0e7490";
  const background = rgbOf(themeColor);

  let bytes: Buffer;
  if (logo) {
    const markSize = Math.round(config.size * config.scale);
    const mark = await sharp(logo).resize(markSize, markSize, { fit: "contain" }).png().toBuffer();
    bytes = await sharp({
      create: {
        width: config.size,
        height: config.size,
        channels: 4,
        background: { ...background, alpha: 1 },
      },
    })
      .composite([{ input: mark, gravity: "centre" }])
      .png()
      .toBuffer();
  } else {
    const fallback = path.join(process.cwd(), "public", "pwa", config.fallback);
    bytes = await readFile(fallback);
  }

  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=300",
    },
  });
}
