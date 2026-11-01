// fs 侧（Node 运行时专用）：仅 Server Action 与公开路由引用，
// 不得被 Server Component 图引入（Turbopack 对组件图里的动态 path 调用报错）。
import { createBrandPoolFs } from "./brand-pool-fs";
import { heroPool } from "./hero-pool";

/** Hero 横幅上限（docs/THEME-SYSTEM.md 决策 7）：PNG ≤2MB、≤1920×1080（宽横幅 PNG 体积大，比 LOGO 放宽） */
export const HERO_MAX_BYTES = 2 * 1024 * 1024;
export const HERO_MAX_WIDTH = 1920;
export const HERO_MAX_HEIGHT = 1080;

export const heroFs = createBrandPoolFs({
  pool: heroPool,
  maxBytes: HERO_MAX_BYTES,
  maxWidth: HERO_MAX_WIDTH,
  maxHeight: HERO_MAX_HEIGHT,
});

/** 上传一枚 PNG 入池并设为当前（≤2MB、≤1920×1080，服务端验魔数与像素）。 */
export const addHero = heroFs.add;
/** 读取池内 Hero 字节（/brand/hero）；不传 file 时取当前项；无可输出返回 null。 */
export const readHeroBytes = heroFs.readBytes;
