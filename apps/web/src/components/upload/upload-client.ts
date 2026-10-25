/**
 * 上传客户端（M6.4d2）：把文件提交到 POST /api/upload，并把服务端的错误码翻译成用户可读的中文。
 * 不做缓存、不做重试：上传是有副作用的（会计入每日配额），失败由用户决定是否重试。
 */

export type UploadPurposeClient = "inline" | "attachment" | "avatar";

export interface UploadResult {
  fileId: number;
  storageKey: string;
  url: string;
  mime: string;
  width: number | null;
  height: number | null;
  sizeBytes: number;
}

/** 服务端错误码 → 中文提示（未知码回落到通用文案） */
const MESSAGES: Readonly<Record<string, string>> = {
  unauthorized: "请先登录后再上传。",
  forbidden: "当前账号不能上传文件。",
  not_found: "你没有权限在该版块上传文件。",
  too_large: "文件太大了，请压缩或换一个更小的文件。",
  unsupported_type: "不支持这种文件类型。",
  type_mismatch: "文件内容与扩展名不一致，已拒绝。",
  extension_not_allowed: "不允许这个扩展名的文件。",
  no_extension: "文件名需要带扩展名。",
  purpose_type: "这个位置不接受此类文件。",
  pixels: "图片尺寸过大。",
  undecodable: "无法读取这张图片，请换一张试试。",
  crop_invalid: "裁剪区域不正确，请重新框选。",
  crop_not_image: "只有图片可以裁剪。",
  gif_crop: "GIF 不支持裁剪，请直接插入。",
  rate_limited: "上传太频繁，请稍后再试。",
  quota_exceeded: "今天的上传次数已用完。",
  avatar_restricted: "当前账号不能设置头像。",
  bad_request: "上传请求不完整，请刷新后重试。",
};

export class UploadError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

export function uploadMessage(code: string): string {
  return MESSAGES[code] ?? "上传失败，请稍后重试。";
}

export async function uploadFile(input: {
  file: File;
  purpose: UploadPurposeClient;
  forumId?: number;
  /** 自然像素的裁剪框（JSON 序列化后随表单提交） */
  crop?: { x: number; y: number; width: number; height: number };
  fetchImpl?: typeof fetch;
}): Promise<UploadResult> {
  const body = new FormData();
  body.append("file", input.file, input.file.name);
  if (input.forumId !== undefined) body.append("forumId", String(input.forumId));
  if (input.crop !== undefined) body.append("crop", JSON.stringify(input.crop));

  const doFetch = input.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`/api/upload?purpose=${input.purpose}`, {
      method: "POST",
      body,
      credentials: "same-origin",
    });
  } catch {
    throw new UploadError("network", "网络异常，请稍后重试。");
  }
  if (!res.ok) {
    let code = "";
    try {
      code = ((await res.json()) as { error?: string }).error ?? "";
    } catch {
      code = "";
    }
    throw new UploadError(code || `http_${res.status}`, uploadMessage(code));
  }
  return (await res.json()) as UploadResult;
}
