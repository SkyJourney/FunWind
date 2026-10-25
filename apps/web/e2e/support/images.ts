/**
 * E2E 用的图片与附件夹具（M6.4d2）。全部内联，不依赖仓库里的图片文件。
 * 1×1 透明 PNG：合法、可被 sharp 解码，足以走完上传 → 落盘 → 插入 → 展示的全链路。
 */
export const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** 一个可下载的文本附件（内容与名称在用例里可区分） */
export const txtAttachment = (name: string) => ({
  name,
  mimeType: "text/plain",
  buffer: Buffer.from(`E2E 附件内容 ${name}`, "utf8"),
});

/** 指定边长的纯色 PNG（裁剪用例需要比最小裁剪边（32）大的图） */
export async function solidPng(size: number): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp({ create: { width: size, height: size, channels: 3, background: "#336699" } })
    .png()
    .toBuffer();
}
