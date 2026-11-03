// fs 侧（Node 运行时专用）：仅 Server Action 与公开路由引用，
// 不得被 Server Component 图引入（Turbopack 对组件图里的动态 path 调用报错）。
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import { getStorageDir } from "@/lib/storage";
import { sniffType } from "@/lib/uploads/sniff";
import { CLI_ACTOR, type ConfigActor } from "@/lib/audit";
import type { BrandPool, BrandPoolHandle } from "./brand-pool";

/**
 * 品牌素材池 fs 半（M11 由 LOGO 池泛化）：PNG-only、服务端验魔数 + sharp 解码验真、
 * 随机文件名直存 STORAGE_DIR/site/（不进 files 表、不内容寻址——品牌素材不走附件授权管线），
 * 写盘成功后由 DB 半登记入池；登记失败回滚删文件。
 */

export interface BrandFsSpec {
  pool: BrandPoolHandle;
  maxBytes: number;
  /** 像素上限（可选）：超出 → oversize；LOGO 不限（小图），Hero 限 1920×1080 */
  maxWidth?: number;
  maxHeight?: number;
}

export type BrandAddErrorCode = "bad_type" | "too_large" | "oversize";

export type BrandAddResult =
  { ok: true; file: string; pool: BrandPool } | { ok: false; code: BrandAddErrorCode };

export interface BrandPoolFs {
  /** 上传一枚 PNG；默认入池即激活，preserveActive 供主题导入保留并发选择；pack 为来源标签。 */
  add(
    name: string,
    bytes: Uint8Array,
    actor?: ConfigActor,
    opts?: { pack?: string; preserveActive?: boolean },
  ): Promise<BrandAddResult>;
  /** 读取池内素材字节（公开路由用）；不传 file 时取当前项，file 必须在池内；无可输出返回 null */
  readBytes(file?: string): Promise<Uint8Array | null>;
}

export function createBrandPoolFs(spec: BrandFsSpec): BrandPoolFs {
  const { pool } = spec;
  const dirOf = () => path.join(getStorageDir(), "site");

  async function add(
    name: string,
    bytes: Uint8Array,
    actor: ConfigActor = CLI_ACTOR,
    opts: { pack?: string; preserveActive?: boolean } = {},
  ): Promise<BrandAddResult> {
    if (bytes.length > spec.maxBytes) return { ok: false, code: "too_large" };
    if (sniffType(bytes) !== "png") return { ok: false, code: "bad_type" };
    let width = 0;
    let height = 0;
    try {
      const { info } = await sharp(bytes, { limitInputPixels: 16_000_000, failOn: "warning" })
        .raw()
        .toBuffer({ resolveWithObject: true });
      width = info.width;
      height = info.height;
    } catch {
      return { ok: false, code: "bad_type" };
    }
    if ((spec.maxWidth && width > spec.maxWidth) || (spec.maxHeight && height > spec.maxHeight)) {
      return { ok: false, code: "oversize" };
    }
    const clean = name.trim().slice(0, 40) || "未命名";
    const file = `${pool.spec.prefix}-${randomBytes(16).toString("hex")}.png`;
    const dir = dirOf();
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, file);
    await writeFile(filePath, bytes, { flag: "wx" });
    try {
      return {
        ok: true,
        file,
        pool: await pool.register(clean, file, actor, opts.pack, {
          preserveActive: opts.preserveActive,
        }),
      };
    } catch (error) {
      await unlink(filePath).catch(() => {});
      throw error;
    }
  }

  async function readBytes(file?: string): Promise<Uint8Array | null> {
    const current = await pool.getRaw();
    const target = file ?? current.active;
    if (!target) return null;
    if (!pool.safeName.test(target)) return null;
    if (!current.items.some((i) => i.file === target)) return null;
    try {
      return await readFile(path.join(dirOf(), target));
    } catch {
      return null;
    }
  }

  return { add, readBytes };
}

/**
 * 品牌素材公开输出（/brand/logo、/brand/hero 共用）：`?file=` 可查看池内任意候选（同为品牌素材不设限）；
 * 无当前项/不在池内 → 404（前台按 chrome 数据回退占位或不渲染，不会出现破图）。
 * 短缓存：切换后最多 5 分钟全局收敛（管理页保存另有 chrome 失效即时性）。
 */
export async function serveBrandImage(req: Request, fs: BrandPoolFs): Promise<Response> {
  const file = new URL(req.url).searchParams.get("file") ?? undefined;
  const bytes = await fs.readBytes(file);
  if (!bytes) return new Response(null, { status: 404 });
  return new Response(bytes as unknown as BodyInit, {
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=300",
    },
  });
}
