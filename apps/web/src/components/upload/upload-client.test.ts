// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
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

describe("uploadFile", () => {
  it("提交 multipart：file / crop 在表单里；purpose 与 forumId 在查询参数里（权限在读体前判定），成功返回服务端结果", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(ok), { status: 200 }));
    const r = await uploadFile({
      file,
      purpose: "inline",
      forumId: 901,
      crop: { x: 1, y: 2, width: 40, height: 40 },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r).toEqual(ok);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/upload?purpose=inline&forumId=901");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    const body = init.body as FormData;
    expect((body.get("file") as File).name).toBe("图.png");
    expect(body.has("forumId")).toBe(false);
    expect(JSON.parse(body.get("crop") as string)).toEqual({ x: 1, y: 2, width: 40, height: 40 });
  });

  it("不带版块与裁剪时不附加对应字段（头像）", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(ok), { status: 200 }));
    await uploadFile({ file, purpose: "avatar", fetchImpl: fetchImpl as unknown as typeof fetch });
    const body = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as FormData;
    expect(body.has("crop")).toBe(false);
  });

  it("服务端错误码映射为中文文案，并保留错误码", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: "type_mismatch" }), { status: 415 }),
    );
    const err = await uploadFile({
      file,
      purpose: "inline",
      forumId: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect(err.code).toBe("type_mismatch");
    expect(err.message).toBe(uploadMessage("type_mismatch"));
  });

  it("错误体不是 JSON 或码未知：回落到通用文案，不抛原始错误", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>500</html>", { status: 500 }));
    const err = await uploadFile({
      file,
      purpose: "attachment",
      forumId: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((e) => e);
    expect(err.code).toBe("http_500");
    expect(err.message).toBe("上传失败，请稍后重试。");
  });

  it("网络异常：统一为 network 错误", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("failed to fetch");
    });
    const err = await uploadFile({
      file,
      purpose: "inline",
      forumId: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((e) => e);
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
