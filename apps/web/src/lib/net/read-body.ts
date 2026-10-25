/**
 * 按字节上限读取请求体（流式计数）。供 Route Handler 使用：Content-Length 只能拦住诚实的客户端，
 * 分块传输（无 Content-Length）必须逐块计数，超限立即取消读取，避免整包进内存。
 */

/**
 * 读取请求体，超过 maxBytes 返回 null（并取消底层读取）。
 * 声明的 Content-Length 超限直接返回 null，不读取任何字节。
 */
export async function readBodyBytes(request: Request, maxBytes: number): Promise<Buffer | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (request.body === null) return Buffer.alloc(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
