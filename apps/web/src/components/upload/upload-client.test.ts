// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubUploadXhr, uploadOkBody } from "@/test/upload-xhr-double";
import { UploadError, uploadFile, uploadMessage } from "./upload-client";

const file = new File([new Uint8Array([1, 2, 3])], "图.png", { type: "image/png" });
const ok = {
  fileId: 7,
  storageKey: "ab/cd/x.png",
  url: "/files/ab/cd/x.png",
  mime: "image/png",
  width: 20,
  height: 20,
  sizeBytes: 3,
};

afterEach(() => {
  vi.unstubAllGlobals(); // 还原全局 XMLHttpRequest 替身（各用例自行安装）
});

describe("uploadFile", () => {
  it("提交 multipart：file / crop 在表单里；purpose 与 forumId 在查询参数里（权限在读体前判定），成功返回服务端结果", async () => {
    const xhr = stubUploadXhr();
    xhr.autoRespond(200, uploadOkBody());
    const r = await uploadFile({
      file,
      purpose: "inline",
      forumId: 901,
      crop: { x: 1, y: 2, width: 40, height: 40 },
    });
    expect(r).toEqual(ok);
    const call = xhr.calls[0]!;
    expect(call.url).toBe("/api/upload?purpose=inline&forumId=901");
    expect(call.method).toBe("POST");
    expect((call.body.get("file") as File).name).toBe("图.png");
    expect(call.body.has("forumId")).toBe(false);
    expect(JSON.parse(call.body.get("crop") as string)).toEqual({
      x: 1,
      y: 2,
      width: 40,
      height: 40,
    });
  });

  it("不带版块与裁剪时不附加对应字段（头像）", async () => {
    const xhr = stubUploadXhr();
    xhr.autoRespond(200, uploadOkBody());
    await uploadFile({ file, purpose: "avatar" });
    expect(xhr.calls[0]!.body.has("crop")).toBe(false);
    expect(xhr.calls[0]!.url).toBe("/api/upload?purpose=avatar");
  });

  it("服务端错误码映射为中文文案，并保留错误码", async () => {
    const xhr = stubUploadXhr();
    xhr.autoRespond(415, JSON.stringify({ error: "type_mismatch" }));
    const err = await uploadFile({ file, purpose: "inline", forumId: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect(err.code).toBe("type_mismatch");
    expect(err.message).toBe(uploadMessage("type_mismatch"));
  });

  it("错误体不是 JSON 或码未知：回落到通用文案，不抛原始错误", async () => {
    const xhr = stubUploadXhr();
    xhr.autoRespond(500, "<html>500</html>");
    const err = await uploadFile({ file, purpose: "attachment", forumId: 1 }).catch((e) => e);
    expect(err.code).toBe("http_500");
    expect(err.message).toBe("上传失败，请稍后重试。");
  });

  it("网络异常：统一为 network 错误", async () => {
    const xhr = stubUploadXhr();
    xhr.autoFail();
    const err = await uploadFile({ file, purpose: "inline", forumId: 1 }).catch((e) => e);
    expect(err.code).toBe("network");
  });

  it("文案表覆盖关键错误码（配额、限流、越权、伪装）", () => {
    for (const code of [
      "rate_limited",
      "quota_exceeded",
      "not_found",
      "type_mismatch",
      "too_large",
    ]) {
      expect(uploadMessage(code)).not.toBe("上传失败，请稍后重试。");
    }
  });
});

describe("uploadFile 上行进度（M16.1 Step 1）", () => {
  it("转发 upload.onprogress 的 loaded/total；总长未知（lengthComputable=false）时不报", async () => {
    const xhr = stubUploadXhr();
    const seen: [number, number][] = [];
    const done = uploadFile({
      file,
      purpose: "attachment",
      onProgress: (l, t) => seen.push([l, t]),
    });
    const call = xhr.calls[0]!;
    call.progress(30, 120);
    call.progress(90, 120);
    call.progressUnknown(); // 总长未知：宁可不报，也不报假百分比
    expect(seen).toEqual([
      [30, 120],
      [90, 120],
    ]);
    call.respond(200, uploadOkBody());
    await done;
  });

  it("上行结束补发一次 loaded===total：消费方据此切「处理中」不定态", async () => {
    const xhr = stubUploadXhr();
    const seen: [number, number][] = [];
    const done = uploadFile({
      file,
      purpose: "attachment",
      onProgress: (l, t) => seen.push([l, t]),
    });
    const call = xhr.calls[0]!;
    call.progress(100, 120); // 末次进度未必恰好等于 total
    call.uploaded();
    expect(seen.at(-1)).toEqual([120, 120]);
    call.respond(200, uploadOkBody());
    await done;
  });

  it("小文件一个 onprogress 都没有：上行结束仍补发完成信号（用文件大小兜底），不停在「准备上传」", async () => {
    const xhr = stubUploadXhr();
    const seen: [number, number][] = [];
    const done = uploadFile({ file, purpose: "avatar", onProgress: (l, t) => seen.push([l, t]) });
    const call = xhr.calls[0]!;
    expect(seen).toEqual([]); // 没有任何进度事件
    call.uploaded();
    expect(seen).toEqual([[file.size, file.size]]);
    call.respond(200, uploadOkBody());
    await done;
  });

  it("取消：UploadError(aborted)，不冒充网络错误", async () => {
    const xhr = stubUploadXhr();
    const done = uploadFile({ file, purpose: "inline" }).catch((e) => e);
    xhr.calls[0]!.abort();
    const err = await done;
    expect(err).toBeInstanceOf(UploadError);
    expect(err.code).toBe("aborted");
    expect(err.message).toBe("上传已取消。");
  });

  it("成功响应体不是合法 JSON：抛出解析错误，不冒充上传成功", async () => {
    const xhr = stubUploadXhr();
    xhr.autoRespond(200, "<html>不是 JSON</html>");
    await expect(uploadFile({ file, purpose: "inline" })).rejects.toThrow();
  });

  it("配额与超限错误码在 XHR 下同样映射（429 / 413）", async () => {
    for (const [status, code] of [
      [429, "quota_exceeded"],
      [413, "too_large"],
      [404, "not_found"],
    ] as const) {
      const xhr = stubUploadXhr();
      xhr.autoRespond(status, JSON.stringify({ error: code }));
      const err = await uploadFile({ file, purpose: "attachment", forumId: 1 }).catch((e) => e);
      expect(err.code).toBe(code);
      expect(err.message).toBe(uploadMessage(code));
    }
  });
});
