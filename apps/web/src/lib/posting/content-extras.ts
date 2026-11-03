import "server-only";
import type { DbTx } from "@/lib/audit";
import { evaluate } from "@/lib/authz/evaluator";
import type { AuthzSnapshot, Subject } from "@/lib/authz/types";
import { registerSourceFiles, type UploadedAttachment } from "@/lib/gates/attachments";
import { applyGateDrafts, type GatePermissions } from "@/lib/gates/write";
import type { PostingError, PreparedBody } from "./service";

/** 门控权限按显式传入的作者主体计算，编辑时不得借用版主身份。 */
export function gatePermissions(
  viewer: Subject,
  forumId: number,
  snap: AuthzSnapshot,
): GatePermissions {
  return {
    points: evaluate(viewer, "gate.points", { forumId }, snap).allowed,
    reply: evaluate(viewer, "gate.reply", { forumId }, snap).allowed,
  };
}

/** 同事务写门控并登记规范化源码的附件；编辑保留细分门控错误码与旧引用例外集合。 */
export async function applyContentExtras(
  tx: DbTx,
  postId: number,
  body: PreparedBody,
  perms: GatePermissions,
  files: Omit<Parameters<typeof registerSourceFiles>[1], "postId" | "source">,
  mode: "create" | "edit" = "create",
): Promise<{ gateCount: number; uploads: UploadedAttachment[] } | PostingError> {
  const gateRes = await applyGateDrafts(tx, postId, body.gates, perms);
  if (!gateRes.ok) {
    return {
      ok: false,
      code: mode === "edit" ? gateRes.error.code : "gate_permission",
      message: gateRes.error.message,
    };
  }
  // 与拆分门控使用同一份规范化源码，公开区与隐藏区的引用必须保持一致。
  const reg = await registerSourceFiles(tx, { ...files, postId, source: body.body });
  if (!reg.ok) return { ok: false, code: reg.code, message: reg.message };
  return { gateCount: gateRes.gateCount, uploads: reg.uploaded };
}
