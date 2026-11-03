// fs 侧（Node 运行时专用）：仅 Server Action 与公开路由引用，
// 不得被 Server Component 图引入（Turbopack 对组件图里的动态 path 调用报错）。
import { createBrandPoolFs } from "./brand-pool-fs";
import { decorPool } from "./decor-pool";

/**
 * 装饰素材上限（M11.1 Step 4）：PNG ≤4MB、≤3840×2160——比 Hero 更宽（主题背景要铺全屏底纹）。
 * 仍只接 PNG（魔数 + sharp 解码验真）：主题包资产走内容寻址外的池化直存，不需要多格式。
 */
export const DECOR_MAX_BYTES = 4 * 1024 * 1024;
export const DECOR_MAX_WIDTH = 3840;
export const DECOR_MAX_HEIGHT = 2160;

export const decorFs = createBrandPoolFs({
  pool: decorPool,
  maxBytes: DECOR_MAX_BYTES,
  maxWidth: DECOR_MAX_WIDTH,
  maxHeight: DECOR_MAX_HEIGHT,
});

/** 上传一枚 PNG 入池（≤4MB、≤3840×2160，服务端验魔数与像素）。 */
export const addDecor = decorFs.add;
/** 读取池内装饰素材字节（/brand/decor）；不传 file 时取当前项；无可输出返回 null。 */
export const readDecorBytes = decorFs.readBytes;
