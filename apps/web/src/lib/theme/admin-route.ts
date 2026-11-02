import { requireAdmin } from "@/lib/authz/require-admin";
import { isSameOrigin } from "@/lib/net/same-origin";
import type { AdminActor } from "@/lib/authz/admin";
import { addDecor } from "@/lib/brand/decor-pool-fs";

/**
 * 主题工作区 JSON 路由的公共外壳（M11.1 Step 7）：
 * 同源校验 + site.admin 门禁 + 统一 JSON 响应。素材类路由（decor 上传/删除、主题 LOGO）
 * 都用它，避免每个路由各写一遍鉴权与错误壳。
 */

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/** 同源 + 管理员鉴权；失败返回 403 响应（无鉴权时），成功返回操作者 */
export async function requireThemeAdmin(
  request: Request,
): Promise<{ actor: AdminActor } | { response: Response }> {
  if (!isSameOrigin(request)) return { response: json({ error: "forbidden" }, 403) };
  const actor = await requireAdmin("site.admin");
  return { actor };
}

/** 读取 multipart 表单；解析失败返回 400 响应 */
export async function readFormData(
  request: Request,
): Promise<{ form: FormData } | { response: Response }> {
  try {
    return { form: await request.formData() };
  } catch {
    return { response: json({ error: "bad_request" }, 400) };
  }
}

/** 构造 ConfigActor 形态的操作者（各路由重复的三行收口） */
export function actorOf(actor: AdminActor) {
  return { userId: actor.userId, via: "admin" as const, ip: actor.ip };
}

/** DELETE 类路由的同一段开头：鉴权 + 解析 JSON body + 取出字符串字段 */
export async function requireThemeJson<T extends Record<string, unknown>>(
  request: Request,
): Promise<{ actor: AdminActor; body: T } | { response: Response }> {
  const auth = await requireThemeAdmin(request);
  if ("response" in auth) return auth;
  const parsed = await readJsonBody<T>(request);
  if ("response" in parsed) return parsed;
  return { actor: auth.actor, body: parsed.body };
}

/** 读取 JSON body；解析失败返回 400 响应 */
export async function readJsonBody<T>(
  request: Request,
): Promise<{ body: T } | { response: Response }> {
  try {
    return { body: (await request.json()) as T };
  } catch {
    return { response: json({ error: "bad_request" }, 400) };
  }
}

/** multipart 表单里的 PNG 文件字段：缺失返回 400 响应 */
export function pngFileOf(form: FormData): { file: File } | { response: Response } {
  const upload = form.get("file");
  return upload instanceof File
    ? { file: upload }
    : { response: json({ error: "bad_request" }, 400) };
}

/** 上传文件的字节与展示名（缺省用文件名） */
export async function uploadBytesOf(
  file: File,
  nameInput: FormDataEntryValue | null,
): Promise<{
  bytes: Uint8Array;
  displayName: string;
}> {
  return {
    bytes: new Uint8Array(await file.arrayBuffer()),
    displayName: typeof nameInput === "string" && nameInput.trim() ? nameInput : file.name,
  };
}

/** POST 上传路由的整段壳：鉴权 + 读 multipart + 取 PNG + 字节/展示名 */
export async function requireThemeUpload(
  request: Request,
): Promise<
  | { actor: AdminActor; file: File; bytes: Uint8Array; displayName: string; form: FormData }
  | { response: Response }
> {
  const auth = await requireThemeAdmin(request);
  if ("response" in auth) return auth;
  const parsed = await readFormData(request);
  if ("response" in parsed) return parsed;
  const png = pngFileOf(parsed.form);
  if ("response" in png) return png;
  const { bytes, displayName } = await uploadBytesOf(png.file, parsed.form.get("name"));
  return {
    actor: auth.actor,
    file: png.file,
    bytes,
    displayName,
    form: parsed.form,
  };
}

/**
 * decor 素材上传 POST 的整段业务（M11.1 Step 7）：上传 → 入池 → 返回 active 项。
 * /admin/themes/assets 与 /admin/decor 管理页（ BrandPoolAdmin 的 upload action 除外）外的
 * JSON 形态调用都走这里，两个路由不再各自重复同一管线。
 */
export async function addDecorFromUpload(request: Request): Promise<Response> {
  const upload = await requireThemeUpload(request);
  if ("response" in upload) return upload.response;
  const result = await addDecor(upload.displayName, upload.bytes, actorOf(upload.actor));
  if (!result.ok) return json({ error: result.code }, 422);
  const active = result.pool.items.find((item) => item.file === result.pool.active);
  return json({ ok: true, file: active?.file, name: active?.name });
}
