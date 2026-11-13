/**
 * RUM 上报协议（M17 Step 4）：**不含任何运行时依赖**的常量与类型，客户端与服务端共用。
 *
 * 为什么单独一个文件：采集组件挂在**根布局**，若它 import 带 zod 的 schema.ts，
 * 即使只取一个常量，整个 zod 也会被拖进**每个页面**的客户端 bundle——
 * 实测因此多出一个 zod chunk 并触发 script-src 违规（M17 Step 4 自查发现并修正）。
 * 所以契约的「形状」放这里（零依赖），zod 校验放 schema.ts（只服务端用）。
 *
 * 双栖模块，**不加 `server-only`**。
 */

/** Core Web Vitals 指标名（与 PerformanceObserver 的 entryType 对应） */
export const RUM_VITAL_NAMES = ["LCP", "CLS", "INP"] as const;
/** 前端错误类型 */
export const RUM_ERROR_NAMES = ["js-error", "unhandled-rejection"] as const;

/** 单次上报最多样本数：够一次会话的指标 + 少量错误，又不至于让请求体变大 */
export const RUM_MAX_SAMPLES = 20;
/** 指标值上限：LCP/INP 毫秒，10 分钟以上视为异常丢弃（CLS 已 ×1000，远小于此） */
export const RUM_VALUE_MAX = 600_000;

export type RumVitalName = (typeof RUM_VITAL_NAMES)[number];
export type RumErrorName = (typeof RUM_ERROR_NAMES)[number];

/**
 * 一条样本。`route` 只收路径（客户端传 location.pathname，不含查询串与片段——
 * 一次性令牌都在查询串里，不让它们离开浏览器）；`detail` 只收错误消息摘要，不收堆栈与参数。
 * 真正的脱敏在服务端做，不信任客户端已脱敏。
 */
export type RumSample =
  | { kind: "vital"; name: RumVitalName; value: number; route: string }
  | { kind: "error"; name: RumErrorName; value: 0; route: string; detail?: string };

export interface RumPayload {
  /** 载荷版本：将来改形状时用它区分，老客户端不至于被静默误读 */
  v: 1;
  samples: RumSample[];
}
