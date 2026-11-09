import "server-only";

/**
 * 运维任务管线 HTTP 客户端（M14，服务端到服务端：funwind-internal 内网 + X-OPS-Token）。
 * 浏览器从不直连管线——后台交互一律经 Server Action（M14：SSR 是交互入口）。
 * 环境变量（M14 D10）：OPS_SERVICE_URL / OPS_API_TOKEN 优先；旧名 BACKUP_SERVICE_URL /
 * BACKUP_OPS_TOKEN 兜底一轮（下个里程碑删），回滚到旧镜像时旧名照样有效。
 */

export interface OpsServiceConfig {
  baseUrl: string;
  token: string;
}

/** 管线连接配置；未配置返回 null（本地开发常态：后台展示「未部署」而非报错） */
export function opsServiceConfig(): OpsServiceConfig | null {
  const baseUrl = process.env.OPS_SERVICE_URL || process.env.BACKUP_SERVICE_URL;
  const token = process.env.OPS_API_TOKEN || process.env.BACKUP_OPS_TOKEN;
  if (!baseUrl || !token) return null;
  return { baseUrl: baseUrl.replace(/\/$/, ""), token };
}

export type OpsTriggerErrorCode =
  "unconfigured" | "busy" | "not-found" | "rejected" | "unauthorized" | "unavailable" | "failed";

export type OpsTriggerResult =
  { ok: true; runId: number } | { ok: false; code: OpsTriggerErrorCode; message: string };

async function detailOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    return typeof body.detail === "string" ? body.detail : "";
  } catch {
    return "";
  }
}

/** 异步手动触发：管线预检后立即返回 run_id（202），执行进度与结果查台账 ops_runs */
export async function triggerOpsTask(taskKey: string): Promise<OpsTriggerResult> {
  const cfg = opsServiceConfig();
  if (!cfg) {
    return {
      ok: false,
      code: "unconfigured",
      message: "运维任务管线未部署（OPS_SERVICE_URL / OPS_API_TOKEN 未配置）",
    };
  }
  try {
    const res = await fetch(`${cfg.baseUrl}/tasks/${encodeURIComponent(taskKey)}/runs`, {
      method: "POST",
      headers: { "x-ops-token": cfg.token },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 202) {
      const runId = Number(((await res.json()) as { run_id?: unknown }).run_id);
      return Number.isInteger(runId) && runId > 0
        ? { ok: true, runId }
        : { ok: false, code: "failed", message: "管线返回了无法识别的运行编号" };
    }
    const detail = await detailOf(res);
    switch (res.status) {
      case 409:
        return { ok: false, code: "busy", message: detail || "同组已有任务在执行，稍后再试" };
      case 404:
        return { ok: false, code: "not-found", message: detail || `任务不存在：${taskKey}` };
      case 400:
        return { ok: false, code: "rejected", message: detail || "任务已停用或未配置手动触发" };
      case 401:
        return {
          ok: false,
          code: "unauthorized",
          message: "管线拒绝了口令（OPS_API_TOKEN 与管线的 OPS_TOKEN 不一致）",
        };
      case 503:
        return { ok: false, code: "unavailable", message: detail || "运维任务管线处于降级状态" };
      default:
        return {
          ok: false,
          code: "failed",
          message: `管线返回 ${res.status}${detail ? `：${detail}` : ""}`,
        };
    }
  } catch (e) {
    return {
      ok: false,
      code: "failed",
      message: `运维任务管线不可达：${(e as Error).message.slice(0, 200)}`,
    };
  }
}

/**
 * 配置变更后的热加载通知（快路径）：best-effort、永不抛错，返回管线是否确认。
 * 管线未部署 / 不可达时静默放过——它的周期对账（默认 5 分钟）会追上配置。
 */
export async function notifyOpsReload(): Promise<boolean> {
  const cfg = opsServiceConfig();
  if (!cfg) return false;
  try {
    const res = await fetch(`${cfg.baseUrl}/config/reload`, {
      method: "POST",
      headers: { "x-ops-token": cfg.token },
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** 管线自身健康（供运维页展示；未配置返回 null）。降级时管线返回 503，正文结构不变。 */
export async function opsServiceHealth(): Promise<{ ok: boolean; jobs: string[] } | null> {
  const cfg = opsServiceConfig();
  if (!cfg) return null;
  try {
    const res = await fetch(`${cfg.baseUrl}/health`, { signal: AbortSignal.timeout(5_000) });
    const body = (await res.json()) as { ok?: boolean; scheduler_jobs?: string[] };
    return { ok: Boolean(body.ok), jobs: body.scheduler_jobs ?? [] };
  } catch {
    return { ok: false, jobs: [] };
  }
}
