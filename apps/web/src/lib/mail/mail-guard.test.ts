// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { FALLBACK_BRAND } from "./brand";
import { MAIL_PREVIEWS } from "./previews";

/**
 * 守卫：邮件发送唯一出口在 lib/mail（批次 0 邮件专项规范）。
 *  · nodemailer 只许 lib/mail/transport.ts 引入——防止绕开发送记录（email_log）的私发通道；
 *  · 业务代码发信只许 import "@/lib/mail" 的 sendMail / trySendMail；
 *  · 模板必须经 renderMail 渲染（templates.ts 里的模板都调它），且每个模板都在 previews.ts
 *    登记了样例（后台可预览 + 守卫强制覆盖）。
 */
const SRC = join(__dirname, "../..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

const runtimeFiles = () =>
  walk(SRC)
    .map((p) => relative(SRC, p))
    .filter((rel) => !/\.test\.tsx?$/.test(rel));

describe("邮件发送唯一出口", () => {
  it("nodemailer 只在 lib/mail/transport.ts 引入", () => {
    const offenders = runtimeFiles().filter(
      (rel) =>
        rel !== join("lib", "mail", "transport.ts") &&
        /from ["']nodemailer["']/.test(readFileSync(join(SRC, rel), "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("调用 sendMail / trySendMail 的文件只从 @/lib/mail 导入它们", () => {
    const SEND_CALL = /\b(?:await\s+)?(?:trySendMail|sendMail)\s*\(/;
    const offenders = runtimeFiles()
      .filter((rel) => rel !== join("lib", "mail", "transport.ts"))
      .filter((rel) => SEND_CALL.test(readFileSync(join(SRC, rel), "utf8")))
      .filter((rel) => {
        const src = readFileSync(join(SRC, rel), "utf8");
        return !/import\s*\{[^}]*\b(?:trySendMail|sendMail)\b[^}]*\}\s*from\s*["']@\/lib\/mail["']/.test(
          src,
        );
      });
    expect(offenders).toEqual([]);
  });
});

describe("模板与预览登记", () => {
  const templatesSrc = readFileSync(join(SRC, join("lib", "mail", "templates.ts")), "utf8");
  const previewsSrc = readFileSync(join(SRC, join("lib", "mail", "previews.ts")), "utf8");

  it("每个导出的 *Mail 模板都在 previews.ts 登记了样例", () => {
    const exported = [...templatesSrc.matchAll(/export function (\w+Mail)\(/g)].map((m) => m[1]!);
    expect(exported.length).toBeGreaterThanOrEqual(14);
    const missing = exported.filter((name) => !previewsSrc.includes(name));
    expect(missing).toEqual([]);
  });

  it("守卫没有空转：已知模板名能被正则识别", () => {
    expect(templatesSrc).toMatch(/export function verifyEmailMail\(/);
    expect(templatesSrc).toMatch(/export function digestMail\(/);
  });

  it("全部预览样例可真实渲染：scene/kind 合法、HTML 与纯文本非空", () => {
    for (const p of MAIL_PREVIEWS) {
      const m = p.build(FALLBACK_BRAND);
      expect(m.scene, p.id).toMatch(/^[a-z0-9-]{1,48}$/);
      expect(KINDS, p.id).toContain(m.kind);
      expect(m.subject.length, p.id).toBeGreaterThan(0);
      expect(m.html, p.id).toContain("<!doctype html>");
      expect(m.text.length, p.id).toBeGreaterThan(0);
    }
  });
});

const KINDS: readonly string[] = ["verify", "security", "notice", "digest", "system"];

describe("邮件域导出完整性（index.ts）", () => {
  it("公开 API 齐备：模板、品牌、发送双入口", async () => {
    const mail = await import("./index");
    for (const name of ["verifyEmailMail", "digestMail", "restrictionMail"]) {
      expect(typeof mail[name as keyof typeof mail], name).toBe("function");
    }
    expect(typeof mail.sendMail).toBe("function");
    expect(typeof mail.trySendMail).toBe("function");
    expect(typeof mail.getMailBrand).toBe("function");
  });
});
