import { z } from "zod";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { BrandPoolHandle } from "./brand-pool";
import type { BrandPoolFs } from "./brand-pool-fs";

/**
 * 品牌素材池管理动作的公共骨架（M11 由 LOGO 动作泛化）：上传入池 / 设为当前 / 移除三件套的
 * input schema 与 run 体；门禁语义固定 site.admin。调用方是各自的 "use server" 文件
 * （admin/logo、admin/hero 的 actions.ts）——那里保留字面 defineAction({ name, auth, ... })，
 * 因为 use-server-exports-guard / admin-entry-guard 两个静态守护要求每个导出动作自带可见的鉴权声明，
 * 禁止转发导出（转发会藏住 auth，审计面不可见）。
 */

interface PoolActionCtx {
  userId: number | null;
  ip: string | null;
}

const actorOf = (ctx: PoolActionCtx) => ({ userId: ctx.userId, via: "admin" as const, ip: ctx.ip });
const backInput = (basePath: string) => z.string().max(200).default(basePath);

/** 上传表单：名称（≤40）+ 文件 + 回跳地址 */
export const brandUploadInput = (basePath: string) =>
  z.object({
    name: z.string().max(40).default(""),
    file: z.instanceof(File),
    back: backInput(basePath),
  });

/** 设为当前 / 移除表单：文件名 + 回跳地址 */
export const brandFileInput = (basePath: string) =>
  z.object({ file: z.string().max(64), back: backInput(basePath) });

type BrandFileInput = z.infer<ReturnType<typeof brandFileInput>>;

export async function uploadToBrandPool(
  fs: BrandPoolFs,
  ctx: PoolActionCtx,
  input: z.infer<ReturnType<typeof brandUploadInput>>,
  basePath: string,
): Promise<void> {
  const bytes = new Uint8Array(await input.file.arrayBuffer());
  const r = await fs.add(input.name, bytes, actorOf(ctx));
  if (!r.ok) redirect(`${basePath}?err=${r.code}`);
  revalidatePath(basePath);
  // 带 added 回跳：新入池项高亮（M9.5）
  redirect(`${basePath}?added=${encodeURIComponent(r.pool.active ?? "")}`);
}

export async function activateInBrandPool(
  pool: BrandPoolHandle,
  ctx: PoolActionCtx,
  input: BrandFileInput,
  basePath: string,
): Promise<void> {
  await pool.setActive(input.file, actorOf(ctx));
  revalidatePath(basePath);
  redirect(input.back);
}

export async function removeBrandPoolItem(
  pool: BrandPoolHandle,
  ctx: PoolActionCtx,
  input: BrandFileInput,
  basePath: string,
): Promise<void> {
  await pool.remove(input.file, actorOf(ctx));
  revalidatePath(basePath);
  redirect(input.back);
}
