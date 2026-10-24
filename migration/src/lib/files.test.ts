import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  auditStored,
  confinedPath,
  FileCollector,
  fileUrl,
  materialize,
  mimeOfExt,
  safeExt,
  storageKeyOf,
} from "./files.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("存储键与扩展名", () => {
  it("存储键由哈希派生：两级目录 + 哈希 + 扩展名", () => {
    const h = sha("a");
    expect(storageKeyOf(h, "png")).toBe(`${h.slice(0, 2)}/${h.slice(2, 4)}/${h}.png`);
    expect(fileUrl("ab/cd/x.png")).toBe("/files/ab/cd/x.png");
  });

  it("扩展名小写；不合法的（过长、含符号、无扩展名）归为 bin", () => {
    expect(safeExt("A/B/Photo.JPG")).toBe("jpg");
    expect(safeExt("x.torrent")).toBe("torrent");
    expect(safeExt("noext")).toBe("bin");
    expect(safeExt("a.verylongext")).toBe("bin");
    expect(safeExt("a.p@ng")).toBe("bin");
  });

  it("扩展名只认白名单：可执行/可脚本化类型与原型链键一律归为 bin（防存储型 XSS）", () => {
    for (const name of ["x.html", "x.htm", "x.svg", "x.js", "x.swf", "x.xml", "x.php", "x.exe"]) {
      expect(safeExt(name), name).toBe("bin");
    }
    expect(safeExt("x.constructor")).toBe("bin");
    expect(safeExt("x.__proto__")).toBe("bin");
    expect(mimeOfExt(safeExt("evil.html"))).toBe("application/octet-stream");
  });

  it("MIME 由扩展名推断，未知为 octet-stream", () => {
    expect(mimeOfExt("jpg")).toBe("image/jpeg");
    expect(mimeOfExt("rar")).toBe("application/vnd.rar");
    expect(mimeOfExt("bin")).toBe("application/octet-stream");
  });
});

describe("FileCollector / materialize / auditStored", () => {
  let root: string;
  let src: string;
  let store: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "funwind-files-"));
    src = join(root, "src");
    store = join(root, "store");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "a.jpg"), "same-content");
    writeFileSync(join(src, "b.jpeg"), "same-content"); // 与 a.jpg 内容相同、扩展名不同
    writeFileSync(join(src, "c.zip"), "other-content");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("同内容合并为一条，扩展名以首次登记者为准，引用次数照实计数", () => {
    const c = new FileCollector();
    const a = c.add(join(src, "a.jpg"));
    const b = c.add(join(src, "b.jpeg"));
    c.add(join(src, "a.jpg")); // 重复登记同一路径
    expect(a).toBe(b);
    expect(a?.ext).toBe("jpg");
    expect(a?.sha256).toBe(sha("same-content"));
    expect(c.size).toBe(1);
    expect(c.referenceCount).toBe(3);
  });

  it("文件不存在返回 null 并记入 missing；all() 按 sha256 升序", () => {
    const c = new FileCollector();
    expect(c.add(join(src, "nope.png"))).toBeNull();
    expect(c.missing.size).toBe(1);
    c.add(join(src, "c.zip"));
    c.add(join(src, "a.jpg"));
    const hashes = c.all().map((f) => f.sha256);
    expect(hashes).toEqual([...hashes].sort());
  });

  it("复制到内容寻址路径；重跑跳过已存在且大小一致的文件", () => {
    const c = new FileCollector();
    c.add(join(src, "a.jpg"));
    c.add(join(src, "c.zip"));
    expect(materialize(c.all(), store)).toEqual({ copied: 2, existing: 0 });
    expect(materialize(c.all(), store)).toEqual({ copied: 0, existing: 2 });
    const f = c.all()[0]!;
    expect(readFileSync(join(store, f.storageKey)).length).toBe(f.sizeBytes);
  });

  it("哈希可重算：存储内容被改动或缺失时对账能发现", () => {
    const c = new FileCollector();
    c.add(join(src, "c.zip"));
    const [f] = c.all();
    materialize([f!], store);
    expect(auditStored([f!], store)).toEqual([]);
    writeFileSync(join(store, f!.storageKey), "tampered");
    expect(auditStored([f!], store)).toEqual([f!.storageKey]);
    expect(auditStored([{ sha256: sha("x"), storageKey: "zz/zz/none.bin" }], store)).toEqual([
      "zz/zz/none.bin",
    ]);
  });
});

describe("路径收束（旧站数据是不可信输入）", () => {
  let root: string;
  let base: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "funwind-confine-"));
    base = join(root, "attachment");
    mkdirSync(join(base, "photo"), { recursive: true });
    writeFileSync(join(base, "photo", "ok.jpg"), "ok");
    writeFileSync(join(root, "secret.txt"), "不该被读到");
    symlinkSync(join(root, "secret.txt"), join(base, "photo", "link.txt"));
    symlinkSync(root, join(base, "escape"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("正常相对路径通过；不存在的路径放行交给缺失处理", () => {
    expect(confinedPath(base, "photo/ok.jpg")).toMatch(/photo\/ok\.jpg$/);
    expect(confinedPath(base, "photo/none.jpg")).toMatch(/photo\/none\.jpg$/);
  });

  it("拒绝 ..、绝对路径、NUL 字节、空路径", () => {
    for (const bad of [
      "../secret.txt",
      "photo/../../secret.txt",
      "photo\\..\\..\\secret.txt",
      "/etc/passwd",
      "photo/ok.jpg\0.png",
      "",
    ]) {
      expect(confinedPath(base, bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("拒绝经符号链接逃出根目录（文件链接与目录链接）", () => {
    expect(confinedPath(base, "photo/link.txt")).toBeNull();
    expect(confinedPath(base, "escape/secret.txt")).toBeNull();
  });

  it("addUnder：逃逸路径返回 null 并记入 rejected，绝不读取目录外的文件", () => {
    const c = new FileCollector();
    expect(c.addUnder(base, "photo/ok.jpg")?.sha256).toBe(sha("ok"));
    expect(c.addUnder(base, "../secret.txt")).toBeNull();
    expect(c.addUnder(base, "escape/secret.txt")).toBeNull();
    expect([...c.rejected].sort()).toEqual(["../secret.txt", "escape/secret.txt"]);
    expect(c.size).toBe(1);
    expect(c.all().some((f) => f.sha256 === sha("不该被读到"))).toBe(false);
  });
});
