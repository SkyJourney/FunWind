"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { clearNavKind, releaseNavKind, resolveNavKind, setNavKind } from "@/lib/motion/nav-kind";
import { installNavGuard, NAV_IDLE, type NavGuard, type NavStatus } from "@/lib/motion/nav-guard";

/** 模块级的小 store：核心守卫（不依赖 React）把状态推到这里，进度条用 useSyncExternalStore 读取 */
let status: NavStatus = NAV_IDLE;
const subscribers = new Set<() => void>();
const setStatus = (next: NavStatus) => {
  status = next;
  for (const s of subscribers) s();
};
const subscribe = (cb: () => void) => {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
};

const SLOW_TOAST = "nav-slow";
const FAILED_TOAST = "nav-failed";

/**
 * 导航守卫接线（M10.7 Step 4a）：慢网络与失败兜底，核心逻辑见 lib/motion/nav-guard.ts。
 * - 点击即反馈：顶部进度条 + 被点元素 busy 态（globals.css）+ 同目标重复点击去重；
 * - 慢：超过 3s 提示「网络较慢，仍在加载…」，导航结束自动收起；
 * - 失败 / 离线：toast「加载失败，请重试」（带重试按钮），页面留在原页；
 * - 页面提交（路径或查询变化）即视为导航成功。
 * 放在 Suspense 里（useSearchParams 的要求）。
 */
export function NavigationGuard() {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const guardRef = useRef<NavGuard | null>(null);
  /**
   * 失败之后路由器需要重置一次（M10.7 4d 在**生产构建**上实测发现）：Next 回退整页跳转时会让 Router 组件
   * `use(unresolvedThenable)` 一直挂起、等待页面卸载；我们拦下了跳转，Router 就停在这个状态，
   * 此后对同一目标的导航（再点一次卡片、toast 的「重试」）请求能拿到 200，却永远不会提交。
   * 重置之后再导航则正常。开发模式碰巧不受影响，所以只有生产构建的 E2E 能抓到。
   * 重置用 `router.replace(当前显示的地址)` 而**不是 `router.refresh()`**：此时路由器的规范地址已经是失败的目标，
   * refresh 刷新的正是那个失败的 URL——失败若持续（如只有该页面的服务在报错），重置自己也会失败，
   * 还会把用户随后点别的链接的导航堵在后面（比不重置更糟）。replace 到当前页：既把规范地址拉回当前页，
   * 又只请求一个健康的页面。
   * 不在失败当下立刻刷新：断网时刷新自己也会失败，会形成「失败 → 刷新 → 失败」的循环；
   * 放到用户下一次导航之前做，一次失败只对应一次重置。
   */
  const needsReset = useRef(false);

  useEffect(() => {
    const guard = installNavGuard({
      onStatus: setStatus,
      // 页面过渡方向：确认发起导航时写到 <html data-nav>（popstate 的方向由 NavKindCapture 写）。
      // 含触点扩散 / 收起：内容卡片 → 详情扩散，随后站内链接回到该列表则收起（见 nav-kind.ts）
      onStart: (nav) => {
        if (needsReset.current) {
          needsReset.current = false;
          router.replace(`${window.location.pathname}${window.location.search}`, { scroll: false });
        }
        const { kind, origin } = resolveNavKind(nav);
        setNavKind(kind, origin);
      },
      onOffline: () =>
        toast.error("网络已断开，请检查连接后重试", { id: FAILED_TOAST, duration: 6000 }),
      onSlow: () => toast.message("网络较慢，仍在加载…", { id: SLOW_TOAST, duration: Infinity }),
      onSettled: () => toast.dismiss(SLOW_TOAST),
      onFailure: ({ url, viaClick }) => {
        clearNavKind(); // 失败的导航不会提交，已记录的方向不能残留到下一次导航
        needsReset.current = true;
        toast.error("加载失败，请重试", {
          id: FAILED_TOAST,
          duration: 10_000,
          action: {
            label: "重试",
            onClick: () => {
              if (viaClick) {
                guardRef.current?.begin(url);
                router.push(url);
              } else {
                // 浏览器前进 / 后退失败：地址栏已经变了而页面还在原页，整页加载一次让两者一致
                window.location.reload();
              }
            },
          },
        });
      },
    });
    guardRef.current = guard;
    return () => {
      guard.uninstall();
      guardRef.current = null;
    };
  }, [router]);

  // 地址变化 = 页面已提交 = 导航成功：结束在途状态，并在当次页面过渡结束后释放方向属性
  useEffect(() => {
    guardRef.current?.complete();
    releaseNavKind();
  }, [pathname, search]);

  const current = useSyncExternalStore(
    subscribe,
    () => status,
    () => NAV_IDLE,
  );
  if (!current.showBar) return null;
  return <div role="progressbar" aria-label="页面加载中" className="fw-nav-progress" />;
}
