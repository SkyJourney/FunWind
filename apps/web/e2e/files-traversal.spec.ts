import http from "node:http";
import { expect, test } from "@playwright/test";
import { FIX } from "./support/fixtures";

/**
 * /files 路径穿越与非规范编码变体（审查 C4，M5.6 S4）。
 * 防线是 parseFileKey 的严格白名单正则 + resolveStaticPath 的二次校验；此前只测过字面的 `../etc/passwd`。
 * 这里用**原始 HTTP**发请求：Playwright 的 request 会先过 WHATWG URL 解析，而它会把 `%2e%2e`、`.%2e` 当作点段在客户端就规范化掉，
 * 发不出真正的变体。每个变体都必须得到 404（或被前置层拒绝为 400），绝不能是 200 / 5xx，响应体也不能带出系统文件内容。
 * 对照：规范路径同样用原始 HTTP 发出，必须是 200，证明这条通道本身是通的。
 */

const BASE = new URL("http://127.0.0.1:3200");

function once(rawPath: string): Promise<{ status: number; body: string; location?: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: BASE.hostname, port: BASE.port, path: rawPath, method: "GET" },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("latin1"),
            location: res.headers.location,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** 原始 HTTP GET，最多跟随 3 次重定向（Next 会把 `//`、反斜杠等规范化后 308）；返回最终结果与路径 */
async function raw(rawPath: string): Promise<{ status: number; body: string; finalPath: string }> {
  let current = rawPath;
  for (let hop = 0; ; hop++) {
    const r = await once(current);
    if ([301, 302, 307, 308].includes(r.status) && r.location && hop < 3) {
      const loc = new URL(r.location, BASE);
      current = loc.pathname + loc.search;
      continue;
    }
    return { status: r.status, body: r.body, finalPath: current };
  }
}

test.describe("/files 路径穿越与编码变体", () => {
  let canonical: string; // /files/ab/cd/<sha>.<ext>
  let sha: string;
  let ext: string;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage({ baseURL: BASE.origin });
    await page.goto(`/t/${FIX.thread.image}`);
    canonical = (await page
      .locator('.content-md img[src^="/files/"]')
      .first()
      .getAttribute("src"))!;
    await page.close();
    const m = /^\/files\/[0-9a-f]{2}\/[0-9a-f]{2}\/([0-9a-f]{64})\.([a-z0-9]+)$/.exec(canonical);
    sha = m![1]!;
    ext = m![2]!;
  });

  test("对照：规范路径经原始 HTTP 返回 200（通道本身是通的）", async () => {
    expect((await raw(canonical)).status).toBe(200);
  });

  test("穿越与编码变体：攻击 / 畸形形态一律 404（或 400），绝不 200 / 5xx，也不带出系统文件内容", async () => {
    const d1 = sha.slice(0, 2);
    const d2 = sha.slice(2, 4);
    const file = `${sha}.${ext}`;
    const variants: Record<string, string> = {
      字面点段指向系统文件: "/files/../../../../etc/passwd",
      "%2e%2e": "/files/%2e%2e/%2e%2e/%2e%2e/etc/passwd",
      "%2E%2E 大写": "/files/%2E%2E/%2E%2E/%2E%2E/etc/passwd",
      ".%2e 混合": "/files/.%2e/.%2e/.%2e/etc/passwd",
      "%2e. 混合": "/files/%2e./%2e./%2e./etc/passwd",
      "双重编码 %252e": "/files/%252e%252e/%252e%252e/%252e%252e/etc/passwd",
      "三重编码 %25252e": "/files/%25252e%25252e/etc/passwd",
      反斜杠编码: "/files/..%5c..%5c..%5cetc%5cpasswd",
      "反斜杠编码 大写": "/files/..%5C..%5C..%5Cetc%5Cpasswd",
      字面反斜杠: "/files/..\\..\\..\\etc\\passwd",
      "超长 UTF-8 点 %c0%ae": "/files/%c0%ae%c0%ae/%c0%ae%c0%ae/etc/passwd",
      "超长 UTF-8 斜杠 %c0%af": "/files/..%c0%af..%c0%af..%c0%afetc%c0%afpasswd",
      全角点: "/files/%ef%bc%8e%ef%bc%8e/%ef%bc%8e%ef%bc%8e/etc/passwd",
      "合法形态 + 结尾 /..": `/files/${d1}/${d2}/${file}/..`,
      "合法形态 + 结尾 /../": `/files/${d1}/${d2}/${file}/../`,
      "合法形态 + %00 截断": `/files/${d1}/${d2}/${file}%00.png`,
      "NUL 在中间": `/files/${d1}/${d2}%00/${file}`,
      "合法形态 + 空格": `/files/${d1}/${d2}/${file}%20`,
      "合法形态 + 换行": `/files/${d1}/${d2}/${file}%0a`,
      "合法形态 + 多一段": `/files/${d1}/${d2}/${file}/x`,
      "斜杠编码 %2f（同一文件的别名 URL）": `/files/${d1}%2f${d2}/${file}`,
      "斜杠编码 %2F 全部": `/files/${d1}%2F${d2}%2F${file}`,
      "斜杠编码 仅最后一个": `/files/${d1}/${d2}%2f${file}`,
      大写十六进制: `/files/${d1.toUpperCase()}/${d2.toUpperCase()}/${file.toUpperCase()}`,
      目录哈希不匹配: `/files/00/00/${file}`,
      扩展名带点: `/files/${d1}/${d2}/${sha}..${ext}`,
      扩展名超长: `/files/${d1}/${d2}/${sha}.${"a".repeat(20)}`,
      无扩展名: `/files/${d1}/${d2}/${sha}`,
    };
    const bad: string[] = [];
    for (const [name, p] of Object.entries(variants)) {
      const { status, body, finalPath } = await raw(p);
      const leaked = /root:.*:0:0:|\[boot loader\]/.test(body);
      if (leaked || (status !== 404 && status !== 400))
        bad.push(
          `${name}: ${p} → ${status}（最终 ${finalPath}）${leaked ? "（带出系统文件内容）" : ""}`,
        );
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  test("HTTP 层规范化后落回规范路径的形态：仍是同一个已授权文件（200、内容与规范路径一致），不会指向别处", async () => {
    const d1 = sha.slice(0, 2);
    const d2 = sha.slice(2, 4);
    const file = `${sha}.${ext}`;
    const reference = await raw(canonical);
    expect(reference.status).toBe(200);
    const equivalents: Record<string, string> = {
      点段后回到合法形态: `/files/../files/${d1}/${d2}/${file}`,
      单点段: `/files/${d1}/${d2}/./${file}`,
      开头多余斜杠: `/files//${d1}/${d2}/${file}`,
      分隔处多余斜杠: `/files/${d1}//${d2}/${file}`,
    };
    for (const [name, p] of Object.entries(equivalents)) {
      const r = await raw(p);
      expect(r.status, `${name}: ${p}`).toBe(200);
      expect(r.body.length, name).toBe(reference.body.length);
    }
  });
});
