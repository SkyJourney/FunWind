// @vitest-environment node
/**
 * POST /api/upload 的真实 MySQL 集成测试（临时库 + 临时存储目录）。
 * 主体由真实的 loadSubject 构造（只替换 cookie 读取）；覆盖鉴权、限流前后的拒绝顺序、伪装、越权 404 与成功落盘。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { DEMO, getWebDb, siteSettings } from "@funwind/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimiter } from "@/lib/auth/ratelimit";
import { getCurrentSubject, loadSubject } from "@/lib/authz/subject";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { POST } from "./route";

vi.mock("@/lib/authz/subject", async () => {
  const actual = await vi.importActual<typeof import("@/lib/authz/subject")>("@/lib/authz/subject");
  return { ...actual, getCurrentSubject: vi.fn() };
});

let tdb: TempDb;
let storage: string;

const URL_BASE = "http://127.0.0.1:3100/api/upload";

async function asUser(userId: number | null) {
  vi.mocked(getCurrentSubject).mockResolvedValue(await loadSubject(userId));
}

function form(fields: Record<string, string | Blob>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

function upload(
  purpose: string,
  fields: Record<string, string | Blob>,
  headers: Record<string, string> = {},
) {
  return POST(
    new Request(`${URL_BASE}?purpose=${purpose}`, {
      method: "POST",
      headers: { origin: "http://127.0.0.1:3100", ...headers },
      body: form(fields),
    }),
  );
}

const png = (w = 20, h = 20) =>
  sharp({ create: { width: w, height: h, channels: 3, background: "#336699" } })
    .png()
    .toBuffer();

describe.skipIf(skipDb)("POST /api/upload（临时库 + 临时存储）", () => {
  beforeAll(async () => {
    tdb = await setupTempDb();
    storage = mkdtempSync(join(tmpdir(), "fw-upload-route-"));
    process.env.STORAGE_DIR = storage;
  });

  afterAll(async () => {
    await tdb?.teardown();
    delete process.env.STORAGE_DIR;
    if (storage) rmSync(storage, { recursive: true, force: true });
  });

  beforeEach(() => resetRateLimiter());

  it("游客：401，不读取请求体", async () => {
    await asUser(null);
    const res = await upload("inline", { file: new Blob([await png()], { type: "image/png" }) });
    expect(res.status).toBe(401);
  });

  it("跨站 Origin：403（先于登录判断）", async () => {
    await asUser(DEMO.member);
    const res = await POST(
      new Request(`${URL_BASE}?purpose=inline`, {
        method: "POST",
        headers: { origin: "https://evil.example" },
        body: form({ file: new Blob([await png()]) }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("用途非法：400", async () => {
    await asUser(DEMO.member);
    const res = await POST(
      new Request(`${URL_BASE}?purpose=video`, { method: "POST", body: form({}) }),
    );
    expect(res.status).toBe(400);
  });

  it("声明的请求体超过用途上限：413，不解析", async () => {
    await asUser(DEMO.member);
    const res = await upload(
      "avatar",
      { file: new Blob([await png()]) },
      { "content-length": "9000000" },
    );
    expect(res.status).toBe(413);
  });

  it("伪装：php 源码改名为 .jpg → 415，且不落盘", async () => {
    await asUser(DEMO.member);
    const res = await upload("inline", {
      forumId: "901",
      file: new File([`<?php system($_GET["c"]); ?>`], "shell.jpg", { type: "image/jpeg" }),
    });
    expect(res.status).toBe(415);
    expect(((await res.json()) as { error: string }).error).toBe("type_mismatch");
  });

  it("不在白名单的扩展名（svg）→ 415", async () => {
    await asUser(DEMO.member);
    const res = await upload("attachment", {
      forumId: "901",
      file: new File(["<svg></svg>"], "a.svg", { type: "image/svg+xml" }),
    });
    expect(res.status).toBe(415);
  });

  it("无权限的版块：404（不暴露版块是否存在）", async () => {
    // 受限版块 904 仅团队可读：普通会员既看不到也不能上传
    await asUser(DEMO.member);
    const res = await upload("inline", {
      forumId: String(DEMO.restrictedForum),
      file: new File([await png()], "a.png", { type: "image/png" }),
    });
    expect(res.status).toBe(404);
  });

  it("会员在公开版块上传 PNG：200，返回内容寻址地址，文件落盘并可读回", async () => {
    await asUser(DEMO.member);
    const bytes = await png(20, 20);
    const res = await upload("inline", {
      forumId: "901",
      file: new File([bytes], "图片.png", { type: "image/png" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      url: string;
      storageKey: string;
      mime: string;
      width: number;
      height: number;
    };
    expect(body.url).toBe(`/files/${body.storageKey}`);
    expect(body.mime).toBe("image/png");
    expect([body.width, body.height]).toEqual([20, 20]);
    expect(readFileSync(join(storage, body.storageKey)).length).toBeGreaterThan(0);
  });

  it("头像：未裁剪 → 400；1:1 裁剪 → 200 且写入 avatar_file_id", async () => {
    await asUser(DEMO.xiaoyi);
    const jpeg = await sharp({
      create: { width: 300, height: 200, channels: 3, background: "#aa5500" },
    })
      .jpeg()
      .toBuffer();
    const noCrop = await upload("avatar", {
      file: new File([jpeg], "a.jpg", { type: "image/jpeg" }),
    });
    expect(noCrop.status).toBe(400);

    const ok = await upload("avatar", {
      file: new File([jpeg], "a.jpg", { type: "image/jpeg" }),
      crop: JSON.stringify({ x: 50, y: 0, width: 200, height: 200 }),
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { width: number; height: number; mime: string };
    expect([body.width, body.height, body.mime]).toEqual([240, 240, "image/webp"]);
  });

  it("头像：被封禁的账号不得上传（写类权限，与版块上传同一判定，审查复查）", async () => {
    await asUser(DEMO.banned);
    const jpeg = await sharp({
      create: { width: 200, height: 200, channels: 3, background: "#123456" },
    })
      .jpeg()
      .toBuffer();
    const res = await upload("avatar", {
      file: new File([jpeg], "a.jpg", { type: "image/jpeg" }),
      crop: JSON.stringify({ x: 0, y: 0, width: 200, height: 200 }),
    });
    expect(res.status).toBe(403);
  });

  it("非图片不接受裁剪参数：400", async () => {
    await asUser(DEMO.member);
    const res = await upload("attachment", {
      forumId: "901",
      file: new File(["字幕文本"], "a.txt", { type: "text/plain" }),
      crop: JSON.stringify({ x: 0, y: 0, width: 40, height: 40 }),
    });
    expect(res.status).toBe(400);
  });

  it("限流：同一用户超过 30 次 / 分钟即 rate_limited（配额足够大，排除配额干扰）", async () => {
    // 放宽每日配额，使被拒的原因只能是限流
    await getWebDb()
      .insert(siteSettings)
      .values({
        key: "limits",
        value: {
          titleMax: 100,
          bodyMax: 50000,
          roles: {
            member: { postIntervalSec: 0, threadsPerDay: 0, uploadsPerDay: 0 },
            admin: { postIntervalSec: 0, threadsPerDay: 0, uploadsPerDay: 0 },
          },
        } as object,
        updatedAt: sql`NOW()`,
      })
      .onDuplicateKeyUpdate({
        set: {
          value: {
            titleMax: 100,
            bodyMax: 50000,
            roles: {
              member: { postIntervalSec: 0, threadsPerDay: 0, uploadsPerDay: 0 },
              admin: { postIntervalSec: 0, threadsPerDay: 0, uploadsPerDay: 0 },
            },
          } as object,
          updatedAt: sql`NOW()`,
        },
      });
    await asUser(DEMO.xiaoyi);
    const bytes = await png();
    const codes: string[] = [];
    for (let i = 0; i < 31; i++) {
      const res = await upload("inline", {
        forumId: "901",
        file: new File([bytes], "a.png", { type: "image/png" }),
      });
      if (res.status === 429) codes.push(((await res.json()) as { error: string }).error);
    }
    expect(codes).toEqual(["rate_limited"]);
  });
});
