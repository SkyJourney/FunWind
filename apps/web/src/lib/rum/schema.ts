import "server-only";
import { z } from "zod";
import { RUM_ERROR_NAMES, RUM_MAX_SAMPLES, RUM_VALUE_MAX, RUM_VITAL_NAMES } from "./protocol";

/**
 * RUM 上报载荷的 **zod 校验**（M17 Step 4）：只服务端用（入站请求校验）。
 *
 * 常量与类型的单一事实源在 `protocol.ts`（零依赖），本文件只做校验并转出口——
 * **客户端组件必须 import protocol.ts，不要 import 本文件**：本文件带 zod，
 * 而采集组件挂在根布局，一旦引用就会把 zod 拖进每个页面的客户端 bundle
 * （实测会多出 zod chunk 并触发 script-src 违规，M17 Step 4 自查发现并修正）。
 */
export { RUM_ERROR_NAMES, RUM_MAX_SAMPLES, RUM_VALUE_MAX, RUM_VITAL_NAMES } from "./protocol";
export type { RumErrorName, RumPayload, RumSample, RumVitalName } from "./protocol";

const route = z.string().min(1).max(500);

const vital = z.object({
  kind: z.literal("vital"),
  name: z.enum(RUM_VITAL_NAMES),
  /** LCP/INP 为毫秒；CLS 为分数 ×1000 取整 */
  value: z.number().int().min(0).max(RUM_VALUE_MAX),
  route,
});

const errorSample = z.object({
  kind: z.literal("error"),
  name: z.enum(RUM_ERROR_NAMES),
  /** 错误样本没有数值语义，恒 0（列非空，用 0 而不是 null） */
  value: z.literal(0),
  route,
  detail: z.string().max(500).optional(),
});

export const rumSampleSchema = z.discriminatedUnion("kind", [vital, errorSample]);

export const rumPayloadSchema = z.object({
  v: z.literal(1),
  samples: z.array(rumSampleSchema).min(1).max(RUM_MAX_SAMPLES),
});
