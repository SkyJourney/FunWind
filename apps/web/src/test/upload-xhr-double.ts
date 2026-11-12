import { vi } from "vitest";

/**
 * 上传 XHR 测试替身（M16.1 Step 1）：upload-client 从 fetch 改 XMLHttpRequest 后，
 * 原先 `vi.stubGlobal("fetch", …)` 的注入方式不再适用。本替身接管全局 XMLHttpRequest，
 * 让用例既能断言请求形状（url / FormData），也能手动驱动上行进度、响应、网络失败与取消。
 *
 * 放在 src/test/ 而非 components/upload/：测试基建不计入组件覆盖率分母（与 source-graph.ts 同款）。
 * 用例的 afterEach 调 `vi.unstubAllGlobals()` 即可还原。
 */

/** 一次上传请求的可驱动句柄 */
export interface UploadXhrCall {
  method: string;
  url: string;
  body: FormData;
  /** 触发一次上行进度（lengthComputable=true） */
  progress: (loaded: number, total: number) => void;
  /** 触发一次总长未知的进度（lengthComputable=false）：upload-client 应忽略，不报假百分比 */
  progressUnknown: () => void;
  /** 触发上行结束（upload.onload）：upload-client 据此补发 100% */
  uploaded: () => void;
  /** 服务端响应 */
  respond: (status: number, body: string) => void;
  /** 网络错误 */
  fail: () => void;
  /** 用户/浏览器取消 */
  abort: () => void;
  /** 触发超时 */
  timeout: () => void;
}

export interface UploadXhrDouble {
  /** 已发出的请求（按 send 顺序） */
  calls: UploadXhrCall[];
  /** 设定自动响应：此后每次 send 都在微任务里回应该响应（模拟网络往返） */
  autoRespond: (status: number, body: string) => void;
  /** 设定自动网络失败 */
  autoFail: () => void;
}

/**
 * 安装替身。缺省**不自动响应**——请求停在 pending，由用例通过 calls[i] 手动驱动
 * （上传中禁用、进度显示等用例需要这个中间态）。
 */
export function stubUploadXhr(): UploadXhrDouble {
  const calls: UploadXhrCall[] = [];
  let auto: ((call: UploadXhrCall) => void) | null = null;

  class FakeXhr {
    status = 0;
    responseText = "";
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    timeout = 0;
    readonly upload = {
      onprogress: null as ((e: ProgressEvent<EventTarget>) => void) | null,
      onload: null as (() => void) | null,
    };
    private call: UploadXhrCall | null = null;

    open(method: string, url: string) {
      this.call = {
        method,
        url,
        body: new FormData(),
        progress: (loaded, total) =>
          this.upload.onprogress?.({ lengthComputable: true, loaded, total } as ProgressEvent),
        progressUnknown: () =>
          this.upload.onprogress?.({
            lengthComputable: false,
            loaded: 0,
            total: 0,
          } as ProgressEvent),
        uploaded: () => this.upload.onload?.(),
        respond: (status, body) => {
          // 真实浏览器：成功响应之前上行必然已结束。替身自动补这一步，
          // 避免用例构造出现实中不可能的时序（响应先于 upload.onload）。
          if (status > 0) this.upload.onload?.();
          this.status = status;
          this.responseText = body;
          this.onload?.();
        },
        fail: () => this.onerror?.(),
        abort: () => this.onabort?.(),
        timeout: () => this.ontimeout?.(),
      };
    }

    send(body: FormData) {
      const call = this.call;
      if (!call) throw new Error("FakeXhr: send 前必须先 open");
      call.body = body;
      calls.push(call);
      if (auto) {
        const run = auto;
        queueMicrotask(() => run(call));
      }
    }
  }

  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  return {
    calls,
    autoRespond: (status, body) => {
      auto = (call) => call.respond(status, body);
    },
    autoFail: () => {
      auto = (call) => call.fail();
    },
  };
}

/** 成功响应体（UploadResult 形状），供各用例复用 */
export function uploadOkBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    fileId: 7,
    storageKey: "ab/cd/x.png",
    url: "/files/ab/cd/x.png",
    mime: "image/png",
    width: 20,
    height: 20,
    sizeBytes: 3,
    ...overrides,
  });
}
