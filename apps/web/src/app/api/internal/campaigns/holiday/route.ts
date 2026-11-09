import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import { PIPELINE_ACTOR } from "@/lib/audit";
import { findCampaignByNameAndEffect, createCampaign } from "@/lib/campaigns/admin";
import { findCampaignEffect } from "@/lib/campaigns/effects";
import type { CampaignErrorCode } from "@/lib/campaigns/admin";
import { isValidBeijingDateTime } from "@/lib/datetime";

/**
 * 运维任务管线的内部动作接口（M14 Step 4，D8 三保险之一②③；①是 nginx 对公网 404）：
 * 节日装扮任务的 create-if-absent 写入——同名同 effect 的方案已存在（含站长微调过的）一律原样返回，
 * 管线绝不覆盖站长对当年方案的编辑；不存在才经 campaigns 写服务创建（effect 校验/引用检查/审计/revision
 * 同一条路）。token 鉴权（与管线 OPS_TOKEN 同值，常量时间比较）；仅 funwind-internal 网内可达。
 */

const NAME_MAX = 60;

function tokenOk(header: string | null): boolean {
  const expected = process.env.OPS_API_TOKEN || process.env.BACKUP_OPS_TOKEN || "";
  if (!expected || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface HolidayBody {
  name: string;
  effect: string;
  target: string;
  startsAt: string;
  endsAt: string;
}

/** 管线台账可读的错误文案（G-15 精神：错误必须可理解，不带码返回） */
const CAMPAIGN_ERROR_TEXT: Record<string, string> = {
  "bad-name": "方案名无效",
  "bad-effect": "未注册的效果类型",
  "bad-target": "装扮目标语法无效（包 id 或池文件名不符合规范）",
  "bad-start": "开始时间无效",
  "bad-end": "结束时间无效",
  "bad-window": "时间窗无效（结束须晚于开始）",
  "bad-priority": "优先级无效",
  "behavior-needs-end": "行为类方案必须填结束时间",
  "not-found": "方案不存在",
  conflict: "版本冲突",
  overlap: "同类行为方案时间窗重叠",
};

function parseBody(raw: unknown): HolidayBody | { error: string } {
  if (typeof raw !== "object" || raw === null) return { error: "请求体须为 JSON 对象" };
  const body = raw as Record<string, unknown>;
  for (const [key, max] of [
    ["name", NAME_MAX],
    ["effect", 32],
    ["target", 120],
    ["startsAt", 32],
    ["endsAt", 32],
  ] as const) {
    const value = body[key];
    if (typeof value !== "string" || !value.trim() || value.length > max) {
      return { error: `${key} 须为 1–${max} 字符的字符串` };
    }
  }
  return {
    name: (body.name as string).trim(),
    effect: body.effect as string,
    target: (body.target as string).trim(),
    startsAt: body.startsAt as string,
    endsAt: body.endsAt as string,
  };
}

export async function POST(request: Request) {
  if (!tokenOk(request.headers.get("x-ops-token"))) {
    return NextResponse.json({ error: "x-ops-token 无效" }, { status: 401 });
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const parsed = parseBody(raw);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { name, effect, target, startsAt, endsAt } = parsed;

  const registered = findCampaignEffect(effect);
  if (!registered)
    return NextResponse.json({ error: `未注册的效果类型：${effect}` }, { status: 422 });
  if (registered.kind !== "visual") {
    return NextResponse.json({ error: "节日装扮只支持视觉类效果" }, { status: 422 });
  }
  if (!isValidBeijingDateTime(startsAt) || !isValidBeijingDateTime(endsAt)) {
    return NextResponse.json(
      { error: "窗口须为合法的「YYYY-MM-DD HH:MM:SS」北京时间" },
      { status: 400 },
    );
  }

  // create-if-absent：已存在（含站长微调过的）原样返回，不覆盖
  const existing = await findCampaignByNameAndEffect(name, effect);
  if (existing) {
    return NextResponse.json({ ok: true, existing: true, id: existing.id });
  }

  const result = await createCampaign(
    { name, effect, target, startsAt, endsAt, priority: 0 },
    PIPELINE_ACTOR,
  );
  if (!result.ok) {
    // createCampaign 的错误语义：missing-ref = 目标不存在；其余为规则/窗口配置问题（管线台账可见）
    const text =
      result.code === "missing-ref"
        ? `装扮目标不存在：${target}（未导入或已停用）`
        : (CAMPAIGN_ERROR_TEXT[result.code as CampaignErrorCode] ?? result.code);
    return NextResponse.json({ error: text }, { status: 422 });
  }
  return NextResponse.json({ ok: true, existing: false, id: result.value.id });
}
