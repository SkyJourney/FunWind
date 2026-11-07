/**
 * 安装向导的失败草稿（G-19）：提交失败跳回时把已填字段带回表单。
 * 编码方式与 campaigns/draft 同款（encodeURIComponent(JSON)），解码全程不可信：
 * 长度超限 / 类型不符 / 结构不对一律返回空草稿，绝不让 query 参数注入任意形状。
 */
import { INSTALL_THEME_PACKS } from "@/lib/install/schema";

export interface InstallDraft {
  db?: { host?: string; port?: string; user?: string; password?: string; name?: string };
  site?: { name?: string; tagline?: string; url?: string };
  themePack?: string;
  registration?: { mode?: string; verifyEmail?: boolean };
  admin?: { username?: string; email?: string; password?: string };
}

export const INSTALL_DRAFT_MAX = 4_000;

export function encodeInstallDraft(draft: InstallDraft): string {
  return encodeURIComponent(JSON.stringify(draft));
}

export function decodeInstallDraft(raw: string | undefined): InstallDraft {
  if (!raw || raw.length > INSTALL_DRAFT_MAX) return {};
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(raw));
    if (typeof parsed !== "object" || parsed === null) return {};
    return sanitizeDraft(parsed as Record<string, unknown>);
  } catch {
    return {};
  }
}

function optString(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v.length <= max ? v : undefined;
}

function sanitizeDraft(d: Record<string, unknown>): InstallDraft {
  const out: InstallDraft = {};
  if (typeof d.db === "object" && d.db !== null) {
    const db = d.db as Record<string, unknown>;
    // 口令不进草稿（审查 P1-1/F-6：草稿经 URL 传输，口令留空 = .env 语义）
    out.db = {
      host: optString(db.host, 255),
      port: optString(db.port, 5),
      user: optString(db.user, 64),
      name: optString(db.name, 64),
    };
  }
  if (typeof d.site === "object" && d.site !== null) {
    const site = d.site as Record<string, unknown>;
    out.site = {
      name: optString(site.name, 40),
      tagline: optString(site.tagline, 80),
      url: optString(site.url, 200),
    };
  }
  if (
    typeof d.themePack === "string" &&
    (INSTALL_THEME_PACKS as readonly string[]).includes(d.themePack)
  ) {
    out.themePack = d.themePack;
  }
  if (typeof d.registration === "object" && d.registration !== null) {
    const reg = d.registration as Record<string, unknown>;
    if (reg.mode === "open" || reg.mode === "invite" || reg.mode === "closed") {
      out.registration = {
        mode: reg.mode,
        verifyEmail: reg.verifyEmail === true ? true : undefined,
      };
    }
  }
  if (typeof d.admin === "object" && d.admin !== null) {
    const admin = d.admin as Record<string, unknown>;
    out.admin = {
      username: optString(admin.username, 20),
      email: optString(admin.email, 128),
    };
  }
  return out;
}
