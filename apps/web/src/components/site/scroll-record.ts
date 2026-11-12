/**
 * 跨页滚动存档（M16 Step 2 采集/恢复，Step 4.5 从 NavKindCapture 抽出共享）：
 * 软导航的 history API 会丢弃浏览器的条目滚动存档，Next 的 ScrollHandler 提交时还会滚顶——
 * 因此各页「最后用户滚动」由 NavKindCapture 持续采集到本模块（sessionStorage 持久化，
 * 整页导航的返回也能恢复），返回时按存档强制恢复。
 *
 * - **导航锁**：离开页瞬间对该页上锁，锁窗口内（4s）持续采集不得覆盖该页存档——
 *   否则滚顶残值会把用户真实滚动污染掉。
 * - **锚点钉住**（SmoothAnchors 复用 pinScrollAtCurrent）：页内锚点平滑滚动的每一帧都会
 *   触发持续采集，不先钉住「点击前位置」的话存档会被刷成锚点位置——从锚点历史项返回
 *   就会错恢复到锚点处，破坏浏览器原生语义。
 * - sessionStorage 同步写有成本：滚动采集按 800ms 节流落盘，pagehide/转入后台强制刷盘。
 */

const SCROLL_STORE_KEY = "fw-scroll-map";
/** 滚动记录容量上限：只保留最近的条目，防长会话无限增长 */
const SCROLL_MAP_MAX = 64;
/** 导航锁/锚点钉住时长：覆盖「提交 + ScrollHandler 滚顶 + 平滑滚动动画」窗口 */
export const NAV_LOCK_MS = 4000;
/** 落盘节流窗口：滚动帧高频触发，sessionStorage 同步写不必每帧都做 */
const PERSIST_THROTTLE_MS = 800;

/** 从 sessionStorage 读滚动记录（SSR / 存储不可用时为空表） */
function loadScrollMap(): Map<string, number> {
  const map = new Map<string, number>();
  if (typeof window === "undefined") return map;
  try {
    const raw = window.sessionStorage.getItem(SCROLL_STORE_KEY);
    if (raw)
      for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, number>)) map.set(k, v);
  } catch {
    // 存储不可用：软导航路径仍可用（纯内存表）
  }
  return map;
}

const scrollMap = loadScrollMap();
/** 导航锁：页 key + 截止时间（锁期间该页的采集覆盖被忽略） */
let lock: { page: string; until: number } | null = null;
let lastSavedAt = 0;

function saveScrollMap(): void {
  lastSavedAt = performance.now();
  try {
    window.sessionStorage.setItem(SCROLL_STORE_KEY, JSON.stringify(Object.fromEntries(scrollMap)));
  } catch {
    // 存储不可用：跳过持久化
  }
}

/** 节流落盘；force=true 跳过节流（关键节点：钉住 / 恢复回填 / pagehide） */
function persistScrollMap(force: boolean): void {
  if (!force && performance.now() - lastSavedAt < PERSIST_THROTTLE_MS) return;
  saveScrollMap();
}

function upsertScroll(page: string, value: number): void {
  if (scrollMap.size >= SCROLL_MAP_MAX && !scrollMap.has(page)) {
    const oldest = scrollMap.keys().next().value;
    if (oldest !== undefined) scrollMap.delete(oldest);
  }
  scrollMap.set(page, value);
}

/** 该页导航锁是否仍在窗口内 */
export function scrollLockAlive(page: string): boolean {
  return lock !== null && lock.page === page && performance.now() < lock.until;
}

/** 对指定页上导航锁 */
export function lockScroll(page: string): void {
  lock = { page, until: performance.now() + NAV_LOCK_MS };
}

/** 读某页的最后已知用户滚动（无记录为 0） */
export function getScrollRecord(page: string): number {
  return scrollMap.get(page) ?? 0;
}

/** 滚动采集（滚动帧调用）：写内存表 + 节流落盘；写满删最旧 */
export function recordScroll(page: string, value: number): void {
  upsertScroll(page, value);
  persistScrollMap(false);
}

/**
 * 钉住「当前页 + 当前滚动」（链接点击捕获与锚点滚动共用）：
 * 记录取 max（用户代理点击前会把元素滚入视口造成上滚，不能覆盖用户已滚到的更深位置），
 * 强制落盘并对当前页上导航锁。
 */
export function pinScrollAtCurrent(): void {
  const page = `${window.location.pathname}${window.location.search}`;
  upsertScroll(page, Math.max(scrollMap.get(page) ?? 0, window.scrollY));
  persistScrollMap(true);
  lockScroll(page);
}

/** 恢复回填：把持久化记录重写回内存表并立即落盘（挂载恢复路径修正初始 0 值） */
export function backfillScrollRecord(page: string, value: number): void {
  upsertScroll(page, value);
  persistScrollMap(true);
}

/** 页面即将卸载/转入后台：强制刷盘，整页导航的返回才有据可依 */
export function flushScrollRecord(): void {
  persistScrollMap(true);
}
