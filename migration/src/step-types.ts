import { AS_OF } from "./config.js";
import { newQuery } from "./db.js";
import { FileCollector } from "./lib/files.js";
import type { Report } from "./lib/report.js";

/** 步骤之间共享的上下文：报告、基准时间，以及少量跨步骤数据 */
export interface Ctx {
  report: Report;
  /** 含个人信息的待办清单（写入 migration/reports/，已 gitignore，不入库） */
  privateReport: Report;
  asOf: string;
  /** users 步骤填充；单独运行后续步骤时由 loadUserIds 从库里补齐 */
  userIds: Set<number>;
  /** users 步骤填充：uid → 头像在旧站磁盘上的相对路径；文件管线据此入库并回填 avatar_file_id */
  avatarSources: Map<number, string>;
  /** badges 步骤填充：badge id → 勋章图相对路径（medalDir 之下） */
  badgeIcons: Map<number, string>;
  /** forums 步骤填充（M9.5）：fid → 板块图相对路径（attachmentDir 之下，nw_bbs_forum.icon）；文件管线据此入库并回填 icon_key */
  forumIconSources: Map<number, string>;
  /** 转换阶段收集的、真正被引用的文件；files 步骤据此统一分配 id、复制并写表 */
  files: FileCollector;
  /** content 步骤填充：已解析到文件的附件（files 步骤补上 file_id 后写 attachments） */
  attachments: AttachmentEntry[];
}

export interface AttachmentEntry {
  postId: number;
  /** 归属的门控（post_gates.id），null = 公开；规则见 transform/content.ts bindAttachmentGates */
  gateId: number | null;
  uploaderId: number;
  originalName: string;
  downloads: number;
  createdAt: string;
  sha256: string;
}

export interface Step {
  name: string;
  run: (ctx: Ctx) => Promise<{ rows: number; note?: string }>;
}

export const newCtx = (report: Report, privateReport: Report): Ctx => ({
  report,
  privateReport,
  asOf: AS_OF,
  userIds: new Set(),
  avatarSources: new Map(),
  forumIconSources: new Map(),
  badgeIcons: new Map(),
  files: new FileCollector(),
  attachments: [],
});

/** 报告里的长列表只列前 n 项 */
export const head = (xs: readonly (string | number)[], n = 20) =>
  xs.length <= n ? xs.join("、") : `${xs.slice(0, n).join("、")} 等 ${xs.length} 个`;

export const mapRows = <K>(m: Map<K, number>) =>
  [...m].sort((a, b) => String(a[0]).localeCompare(String(b[0]), "en", { numeric: true }));

/**
 * 单独运行后续步骤时，已迁用户集合从新库读取。
 * 只含真实用户（state=active）：「已注销用户」占位账号只给内容作者/附件上传者建，
 * 积分、关注、点赞、投票、购买等记录不会挂到占位账号上。
 */
export async function loadUserIds(ctx: Ctx): Promise<Set<number>> {
  if (ctx.userIds.size === 0) {
    const rows = await newQuery<{ id: number }>("SELECT id FROM users WHERE state = 'active'");
    ctx.userIds = new Set(rows.map((r) => Number(r.id)));
  }
  return ctx.userIds;
}

export async function idSet(sql: string): Promise<Set<number>> {
  const rows = await newQuery<{ id: number }>(sql);
  return new Set(rows.map((r) => Number(r.id)));
}

/** 迁移前置：确保系统种子已就位（角色/权限词汇表） */
export async function assertSystemSeeded(): Promise<void> {
  const [row] = await newQuery<{ n: number }>("SELECT COUNT(*) AS n FROM roles");
  if (Number(row?.n ?? 0) === 0) {
    throw new Error("roles 为空：请先 pnpm db:bootstrap（bootstrap 会写入系统种子）");
  }
}
