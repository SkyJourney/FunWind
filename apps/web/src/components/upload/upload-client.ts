/**
 * 上传客户端（M6.4d2；M16.1 Step 1 改 XHR 取上行进度）：把文件提交到 POST /api/upload，
 * 并把服务端的错误码翻译成用户可读的中文。
 * 不做缓存、不做重试：上传是有副作用的（会计入每日配额），失败由用户决定是否重试。
 *
 * **为什么是 XMLHttpRequest 而不是 fetch**：fetch 没有请求上行进度事件；ReadableStream 请求体
 * （duplex:"half"）浏览器支持不全，且「被网络层拉走」不等于「服务端已确认」，本服务端又是整包
 * 缓冲——拿不到可信进度。XHR 的 `upload.onprogress` 是原生能力，零新依赖，服务端无需改动。
 *
 * **上行 100% ≠ 上传完成**：服务端读完请求体后还要嗅探类型、sharp 重编码、落盘，这段时间没有
 * 进度可报。因此上行结束时会补发一次 loaded===total 的回调，消费方据此切「处理中…」不定态。
 */

export type UploadPurposeClient = "inline" | "attachment" | "avatar";

/** 上传超时：50MB 附件在慢网下也可能几分钟，取宽松值只兜「网络黑洞」，不打断正常慢传 */
const UPLOAD_TIMEOUT_MS = 5 * 60_000;

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
  /**
   * 上行进度（字节）：total 含 multipart 开销，故百分比是近似值。
   * 上行结束会补发一次 loaded===total——消费方据此从「上传中 N%」切到「处理中…」不定态。
   */
  onProgress?: (loaded: number, total: number) => void;
  /** 传输注入缝（测试用）：缺省用原生 XMLHttpRequest */
  xhrImpl?: () => XMLHttpRequest;
}): Promise<UploadResult> {
  const body = new FormData();
  body.append("file", input.file, input.file.name);
  if (input.crop !== undefined) body.append("crop", JSON.stringify(input.crop));
  // 版块放在查询参数里：服务端据此在读取请求体之前完成权限判定（越权的请求不必上传内容）
  const query = new URLSearchParams({ purpose: input.purpose });
  if (input.forumId !== undefined) query.set("forumId", String(input.forumId));

  const createXhr = input.xhrImpl ?? (() => new XMLHttpRequest());
  return new Promise<UploadResult>((resolve, reject) => {
    const xhr = createXhr();
    // 同源 XHR 默认携带 cookie，等价于原 fetch 的 credentials: "same-origin"
    xhr.open("POST", `/api/upload?${query.toString()}`, true);
    const report = input.onProgress;
    if (report) {
      let total = 0;
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return; // 总长未知时不报进度（宁可不显示，不显示假百分比）
        total = e.total;
        report(e.loaded, e.total);
      };
      // 上行结束的补发：两种情况都要覆盖——① 末次 onprogress 未必恰好等于 total；
      // ② 小文件可能一个 onprogress 都不触发（total 仍为 0），此时用文件大小兜底，
      //    否则消费方会一直停在「准备上传」直到响应回来（E2E 实测发现）。
      xhr.upload.onload = () => {
        const settled = total > 0 ? total : Math.max(1, input.file.size);
        report(settled, settled);
      };
    }
    // 超时（M16.1 Step 4.5）：fetch 时代也没有超时，但有了进度条后「卡在 N%」更显眼——
    // 网络黑洞时给一个确定的失败终态，而不是让提交按钮永远禁用、只能刷新。
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.ontimeout = () => reject(new UploadError("network", "网络异常，请稍后重试。"));
    xhr.onerror = () => reject(new UploadError("network", "网络异常，请稍后重试。"));
    xhr.onabort = () => reject(new UploadError("aborted", "上传已取消。"));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as UploadResult);
        } catch (e) {
          reject(e); // 成功响应体不是合法 JSON：与原 fetch 的 res.json() 同样抛出，不冒充上传成功
        }
        return;
      }
      let code = "";
      try {
        code = (JSON.parse(xhr.responseText) as { error?: string }).error ?? "";
      } catch {
        code = "";
      }
      reject(new UploadError(code || `http_${xhr.status}`, uploadMessage(code)));
    };
    xhr.send(body);
  });
}
