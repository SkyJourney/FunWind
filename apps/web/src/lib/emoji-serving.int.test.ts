// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emojiGroups, emojis, getWebDb } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { handleEmojiRequest } from "./emoji-serving";

/**
 * /emoji 提供路由的真实 MySQL 集成测试（临时库 + 临时存储目录 + 真实文件）。
 * 覆盖设计稿 §2.2 的全部分支：合式 200、ext 不一致 404、不存在 404、停用仍 200、304、
 * 静态资源（storage_key 为空）不兜底、存储缺失 404。
 */
let tdb: TempDb;
let storage: string;

/** 落一个真实文件并登记 emojis 行；enabled 缺省 true，可传 null 的 storageKey 模拟静态旧枚 */
async function putEmoji(
  id: number,
  ext: string,
  opts: { enabled?: boolean; storageKey?: string | null; write?: boolean } = {},
) {
  const [group] = (await getWebDb()
    .insert(emojiGroups)
    .values({
      name: `测试分组 ${id}`,
      sort: 0,
      createdAt: "2026-10-01 00:00:00",
      updatedAt: "2026-10-01 00:00:00",
    })) as unknown as [{ insertId: number }];
  // 内容按 id 派生：内容寻址下不同 id 的 sha 不同，「存储缺失」用例才不会被前面用例写过的文件命中
  const content = Buffer.from(`emoji-serving-test-${id}`);
  const sha = createHash("sha256").update(content).digest("hex");
  const key =
    opts.storageKey !== undefined
      ? opts.storageKey
      : `${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}.${ext}`;
  if ((opts.write ?? true) && key !== null) {
    mkdirSync(join(storage, sha.slice(0, 2), sha.slice(2, 4)), { recursive: true });
    writeFileSync(join(storage, key), content);
  }
  await getWebDb()
    .insert(emojis)
    .values({
      id,
      groupId: Number(group.insertId),
      name: `测试表情 ${id}`,
      ext,
      storageKey: key,
      enabled: opts.enabled ?? true,
      createdAt: "2026-10-01 00:00:00",
      updatedAt: "2026-10-01 00:00:00",
    });
  return { sha, key };
}

const get = (file: string, init?: RequestInit) =>
  handleEmojiRequest(new Request(`http://x/emoji/${file}`, init), file, storage);

beforeAll(async () => {
  if (skipDb) return;
  tdb = await setupTempDb();
  storage = mkdtempSync(join(tmpdir(), "emoji-serving-"));
});

afterAll(async () => {
  if (skipDb) return;
  await tdb.teardown();
  rmSync(storage, { recursive: true, force: true });
});

describe.skipIf(skipDb)("handleEmojiRequest", () => {
  it("合式请求：200 + 全套安全与缓存头，内容逐字节一致", async () => {
    await putEmoji(170, "png");
    const res = await get("170.png");
    expect(res.status).toBe(200);
    const h = res.headers;
    expect(h.get("content-type")).toBe("image/png");
    expect(h.get("content-disposition")).toBe("inline");
    expect(h.get("x-content-type-options")).toBe("nosniff");
    expect(h.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(h.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from("emoji-serving-test-170"))).toBe(
      true,
    );
  });

  it("If-None-Match 命中 → 304 只带 ETag", async () => {
    const { sha } = await putEmoji(171, "gif");
    const res = await get("171.gif", { headers: { "if-none-match": `"${sha}"` } });
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(`"${sha}"`);
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it("ext 与库内不一致 → 404", async () => {
    await putEmoji(172, "png");
    expect((await get("172.gif")).status).toBe(404);
  });

  it("库里不存在 → 404；enabled=false 仍 200（停用只影响面板，正文不能碎）", async () => {
    expect((await get("999999.png")).status).toBe(404);
    await putEmoji(173, "png", { enabled: false });
    expect((await get("173.png")).status).toBe(200);
  });

  it("storage_key 为空（静态旧枚形态）路由不兜底 → 404；文件名不合式 → 404", async () => {
    await putEmoji(174, "gif", { storageKey: null, write: false });
    expect((await get("174.gif")).status).toBe(404);
    for (const bad of [
      "abc.gif",
      "175.jpeg",
      "175.GIF",
      "175",
      "../175.png",
      "99999999999999999999.png",
    ]) {
      expect((await get(bad)).status, bad).toBe(404);
    }
  });

  it("库有记录但存储缺失 → 404 并留日志线索", async () => {
    await putEmoji(175, "png", { write: false });
    expect((await get("175.png")).status).toBe(404);
  });
});
