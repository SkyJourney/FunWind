import { normalizeKey } from "@funwind/db";
import { toDatetime } from "../config.js";

export interface OldUser {
  uid: number;
  username: string;
  email_u: string | null;
  email_w: string | null;
  regdate: number;
  lastvisit: number | null;
  gender: number | null;
  location_text: string | null;
  homepage: string | null;
  bbs_sign: string | null;
  profile: string | null;
  byear: number | null;
  bmonth: number | null;
  bday: number | null;
}

export interface UserRow {
  id: number;
  username: string;
  usernameKey: string;
  email: string | null;
  emailKey: string | null;
  passwordHash: null;
  emailVerifiedAt: null;
  state: "active" | "deleted";
  createdAt: string;
  lastLoginAt: string | null;
}

export interface ProfileRow {
  userId: number;
  bio: string | null;
  location: string;
  website: string;
  gender: number;
  birthday: string | null;
  signatureMd: string | null;
  /** 头像在旧站磁盘上的相对路径（attachment/ 之下）；文件管线入库后才得到 avatar_file_id */
  avatarSource: string | null;
}

export interface UserTransformOptions {
  /** 不迁移的账号（只发过垃圾空壳主题的 spam 账号）：旧库保留即归档 */
  excludeUids: ReadonlySet<number>;
  /** uid → 该用户最早的发帖/回帖时间（用于修复 regdate=0） */
  firstActivity: ReadonlyMap<number, string>;
  /** 头像主图在磁盘上是否存在 */
  avatarExists: (uid: number) => boolean;
  /** UBB 签名 → Markdown（签名里不允许门控，调用方负责丢弃门控占位） */
  convertSignature: (ubb: string) => string;
  /** 缺失注册时间时的最后兜底 */
  fallbackCreatedAt: string;
}

export interface UserTransformResult {
  users: UserRow[];
  profiles: ProfileRow[];
  notes: {
    usernameCollisions: { uid: number; from: string; to: string }[];
    invalidEmails: { uid: number; email: string }[];
    /** 重复邮箱：保留最早注册者，其余置空待人工处理 */
    duplicateEmails: { email: string; keptUid: number; clearedUids: number[] }[];
    createdAtRepaired: { uid: number; to: string; source: "activity" | "lastvisit" | "fallback" }[];
    emptyUsernames: number[];
    avatars: number;
    /** 因 spam 而未迁移的账号数 */
    excluded: number;
  };
}

const EMAIL_RE = /^[^\s@'"<>]+@[^\s@'"<>]+\.[^\s@'"<>]+$/;

/** 旧站头像路径算法（与 apps/web/src/lib/auth/avatar.ts 一致）：avatar/{3位}/{2位}/{2位}/{uid}.jpg */
export function legacyAvatarKey(uid: number): string {
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  return `avatar/${pad(Math.floor(uid / 1_000_000) % 1000, 3)}/${pad(
    Math.floor(uid / 10_000) % 100,
    2,
  )}/${pad(Math.floor(uid / 100) % 100, 2)}/${uid}.jpg`;
}

function validBirthday(y: number | null, m: number | null, d: number | null): string | null {
  if (!y || !m || !d || y < 1900 || y > 2026 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return null;
  }
  const p = (n: number) => String(n).padStart(2, "0");
  return `${y}-${p(m)}-${p(d)}`;
}

export function transformUsers(
  rows: readonly OldUser[],
  opts: UserTransformOptions,
): UserTransformResult {
  const notes: UserTransformResult["notes"] = {
    usernameCollisions: [],
    invalidEmails: [],
    duplicateEmails: [],
    createdAtRepaired: [],
    emptyUsernames: [],
    avatars: 0,
    excluded: 0,
  };

  // spam 账号不迁移：它们只发过被丢弃的垃圾空壳，保留只会留下无人引用的空账号
  const kept = rows.filter((r) => !opts.excludeUids.has(Number(r.uid)));
  const notesExcluded = rows.length - kept.length;
  const sorted = [...kept].sort((a, b) => Number(a.uid) - Number(b.uid));

  // 邮箱归属：同一归一化邮箱保留注册最早者（regdate 升序，uid 兜底）
  const emailOf = new Map<number, string>();
  const holders = new Map<string, OldUser[]>();
  for (const r of sorted) {
    const raw = (r.email_w || r.email_u || "").trim();
    if (!raw) continue;
    if (!EMAIL_RE.test(raw)) {
      notes.invalidEmails.push({ uid: Number(r.uid), email: raw });
      continue;
    }
    const key = normalizeKey(raw);
    emailOf.set(Number(r.uid), raw);
    const list = holders.get(key) ?? [];
    list.push(r);
    holders.set(key, list);
  }
  const keepEmail = new Set<number>();
  for (const [key, list] of holders) {
    const ordered = [...list].sort(
      (a, b) =>
        (Number(a.regdate) || Number.MAX_SAFE_INTEGER) -
          (Number(b.regdate) || Number.MAX_SAFE_INTEGER) || Number(a.uid) - Number(b.uid),
    );
    keepEmail.add(Number(ordered[0]!.uid));
    if (ordered.length > 1) {
      notes.duplicateEmails.push({
        email: key,
        keptUid: Number(ordered[0]!.uid),
        clearedUids: ordered.slice(1).map((r) => Number(r.uid)),
      });
    }
  }

  const usedKeys = new Set<string>();
  const users: UserRow[] = [];
  const profiles: ProfileRow[] = [];

  for (const r of sorted) {
    const uid = Number(r.uid);
    let username = String(r.username ?? "").trim();
    if (!username) {
      username = `user${uid}`;
      notes.emptyUsernames.push(uid);
    }
    let key = normalizeKey(username);
    if (usedKeys.has(key)) {
      const to = `${username}_${uid}`;
      notes.usernameCollisions.push({ uid, from: username, to });
      username = to;
      key = normalizeKey(username);
    }
    usedKeys.add(key);

    let createdAt = toDatetime(Number(r.regdate));
    if (!createdAt) {
      const activity = opts.firstActivity.get(uid);
      const lastvisit = toDatetime(r.lastvisit);
      if (activity) {
        createdAt = activity;
        notes.createdAtRepaired.push({ uid, to: createdAt, source: "activity" });
      } else if (lastvisit) {
        createdAt = lastvisit;
        notes.createdAtRepaired.push({ uid, to: createdAt, source: "lastvisit" });
      } else {
        createdAt = opts.fallbackCreatedAt;
        notes.createdAtRepaired.push({ uid, to: createdAt, source: "fallback" });
      }
    }

    const emailRaw = emailOf.get(uid);
    const hasEmail = emailRaw !== undefined && keepEmail.has(uid);
    users.push({
      id: uid,
      username,
      usernameKey: key,
      email: hasEmail ? emailRaw!.trim() : null,
      emailKey: hasEmail ? normalizeKey(emailRaw!) : null,
      passwordHash: null, // 红线：旧哈希不迁移，上线走邮件认领/重置
      emailVerifiedAt: null,
      state: "active",
      createdAt,
      lastLoginAt: toDatetime(r.lastvisit),
    });

    const avatarSource = opts.avatarExists(uid) ? legacyAvatarKey(uid) : null;
    if (avatarSource) notes.avatars++;
    const signature = r.bbs_sign ? opts.convertSignature(String(r.bbs_sign)) : "";
    profiles.push({
      userId: uid,
      bio: r.profile ? String(r.profile) : null,
      location: r.location_text ?? "",
      website: r.homepage ?? "",
      gender: [0, 1, 2].includes(Number(r.gender)) ? Number(r.gender) : 0,
      birthday: validBirthday(
        r.byear === null ? null : Number(r.byear),
        r.bmonth === null ? null : Number(r.bmonth),
        r.bday === null ? null : Number(r.bday),
      ),
      signatureMd: signature || null,
      avatarSource,
    });
  }

  notes.excluded = notesExcluded;
  return { users, profiles, notes };
}

export const placeholderUsername = (uid: number): string => `已注销用户#${uid}`;

/**
 * 引用诚实：内容的作者必须指向 users 里真实存在的一行。
 * 被保留的内容引用了已不存在的旧 uid（旧站删号、虚拟账号 uid 1 等）时，沿用原 uid 建「已注销用户」占位账号：
 * state=deleted，无邮箱无密码，用户名带 uid 保证唯一；内容表不加任何冗余列。
 * @param firstSeen uid → 该作者最早的内容时间（占位账号的 created_at，保证确定性）
 */
export function transformPlaceholders(firstSeen: ReadonlyMap<number, string>): {
  users: UserRow[];
  profiles: ProfileRow[];
} {
  const users: UserRow[] = [];
  const profiles: ProfileRow[] = [];
  for (const [uid, createdAt] of [...firstSeen].sort((a, b) => a[0] - b[0])) {
    const username = placeholderUsername(uid);
    users.push({
      id: uid,
      username,
      usernameKey: normalizeKey(username),
      email: null,
      emailKey: null,
      passwordHash: null,
      emailVerifiedAt: null,
      state: "deleted",
      createdAt,
      lastLoginAt: null,
    });
    profiles.push({
      userId: uid,
      bio: null,
      location: "",
      website: "",
      gender: 0,
      birthday: null,
      signatureMd: null,
      avatarSource: null,
    });
  }
  return { users, profiles };
}
