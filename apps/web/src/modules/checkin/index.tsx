import Link from "next/link";
import { CalendarCheck, CheckCircle2 } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/session";
import { getCheckinStatus, type CheckinStatus } from "@/lib/checkin/service";
import { defineModule } from "../kernel/types";

/**
 * 签到模块（M7）：每日签到（北京时间自然日）+ 连签 + 随机奖励（earn.checkin 渠道）。
 * 首页 `home.after-header` 槽位渲染签到条与本月迷你日历。
 * 安全口径（继承 post-m5.5 审查对 demo 槽位的教训）：只展示**当前用户自己**的签到状态，
 * 不显示任何他人活动（游客只看到登录引导）。
 */

/** 月份网格：周日起的 7 列，前导空位用 null（纯 UTC 日历计算，无时区歧义） */
function monthGrid(year: number, month1based: number): (number | null)[][] {
  const first = new Date(Date.UTC(year, month1based - 1, 1, 12));
  const days = new Date(Date.UTC(year, month1based, 0, 12)).getUTCDate();
  const cells: (number | null)[] = Array.from({ length: first.getUTCDay() }, () => null);
  for (let d = 1; d <= days; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (number | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

function MiniCalendar({ status }: { status: CheckinStatus }) {
  const [y, m] = [Number(status.today.slice(0, 4)), Number(status.today.slice(5, 7))];
  const todayDay = Number(status.today.slice(8, 10));
  const checked = new Set(status.monthDates.map((d) => Number(d.slice(8, 10))));
  return (
    <div className="grid grid-cols-7 gap-1 text-center text-[10px] text-muted-foreground tabular-nums">
      {["日", "一", "二", "三", "四", "五", "六"].map((w) => (
        <span key={w}>{w}</span>
      ))}
      {monthGrid(y, m)
        .flat()
        .map((day, i) => (
          <span
            key={i}
            className={
              day === null
                ? ""
                : [
                    "rounded-md py-0.5",
                    checked.has(day)
                      ? "bg-primary/15 font-medium text-primary"
                      : day === todayDay
                        ? "border border-dashed border-ring"
                        : "",
                  ].join(" ")
            }
          >
            {day ?? ""}
          </span>
        ))}
    </div>
  );
}

async function renderCheckinBar() {
  const user = await getCurrentUser();
  if (!user) {
    return (
      <div className="flex items-center justify-between rounded-xl border bg-card px-4 py-3 text-sm">
        <span className="text-muted-foreground">📅 每日签到，连续签到有惊喜</span>
        <Link href="/login" className="font-medium text-primary hover:underline">
          登录后签到
        </Link>
      </div>
    );
  }
  // 渲染期动态 import：静态引入会构成「模块 → defineAction → "@/modules"」的求值环（见 actions/checkin.ts 说明）
  const { checkinAction } = await import("@/app/actions/checkin");
  const status = await getCheckinStatus(user.id);
  // 同构设计（M10.6d 站长反馈）：签到按钮与已签到标识占同一位置、同一尺寸档，
  // 移动端窄视口下不换行留白——左侧文字/日历自适应收缩，右侧动作位恒定存在。
  const actionSlot = status.checkedInToday ? (
    <span
      aria-label="今日已签到"
      className="inline-flex h-10 items-center justify-center gap-1.5 rounded-xl border border-success/30 bg-success/10 px-4 text-sm font-medium text-success"
    >
      <CheckCircle2 className="size-4" aria-hidden /> 已签到
    </span>
  ) : (
    <form action={checkinAction}>
      <button
        type="submit"
        className="inline-flex h-10 items-center justify-center gap-1.5 rounded-xl bg-primary px-5 text-sm font-medium text-primary-foreground shadow-sm transition-transform active:scale-95"
      >
        <CalendarCheck className="size-4" aria-hidden /> 签到
      </button>
    </form>
  );

  return (
    <div className="rounded-xl border bg-card px-4 py-3 xl:hidden">
      {/* 第一行：文字摘要（左）+ 动作位（右，恒定存在不换行） */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            {status.checkedInToday
              ? `今日已签到 ✓ 已连签 ${status.streak} 天`
              : `今日未签到 · 已连签 ${status.streak} 天`}
          </p>
          <p className="text-xs text-muted-foreground">
            本月已签 {status.monthDates.length} 天 · 累计 {status.totalDays} 天
          </p>
        </div>
        {actionSlot}
      </div>
      {/* 第二行：迷你日历（整行宽度，移动端不再挤在右侧） */}
      <div className="mt-2 border-t pt-2">
        <MiniCalendar status={status} />
      </div>
    </div>
  );
}

/**
 * 首页右栏签到卡（M10.5 视觉规范）：xl 宽桌的侧栏位。
 * 与横铺签到条共用同一份状态——窄屏由 home.after-header 承担，桌面由本卡承担，互斥不重复。
 */
async function renderCheckinRail() {
  const user = await getCurrentUser();
  // 游客的签到引导由主列横铺条承担（唯一出口）；此处不渲染，避免同一信息出现两遍
  if (!user) return null;
  const { checkinAction } = await import("@/app/actions/checkin");
  const status = await getCheckinStatus(user.id);
  // 与移动签到条同构（M10.6d 站长要求 PC/移动相同样式）：状态行 + 日历 + 底部动作位
  // （签到按钮 / 已签到标识同位同尺寸，签到后不留空）。
  const actionSlot = status.checkedInToday ? (
    <span className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-xl border border-success/30 bg-success/10 text-sm font-medium text-success">
      <CheckCircle2 className="size-4" aria-hidden /> 今日已签到
    </span>
  ) : (
    <form action={checkinAction}>
      <button
        type="submit"
        className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-xl bg-primary text-sm font-medium text-primary-foreground shadow-sm transition-transform hover:bg-primary/90 active:scale-95"
      >
        <CalendarCheck className="size-4" aria-hidden /> 签到
      </button>
    </form>
  );
  return (
    <section className="rounded-xl border bg-card p-4">
      <h2 className="text-sm font-semibold">每日签到</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        {status.checkedInToday
          ? `今日已签到 ✓ 已连签 ${status.streak} 天`
          : `今日未签到 · 已连签 ${status.streak} 天`}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        本月已签 {status.monthDates.length} 天 · 累计 {status.totalDays} 天
      </p>
      <div className="mt-2">
        <MiniCalendar status={status} />
      </div>
      <div className="mt-3">{actionSlot}</div>
    </section>
  );
}

export const checkinModule = defineModule({
  id: "checkin",
  description:
    "签到模块：每日签到（北京时间自然日边界）+ 连签计数 + 随机奖励（earn.checkin，punch.reward 配置）；首页签到条与本月迷你日历。",
  pointChannels: [{ key: "earn.checkin", direction: "earn", label: "签到奖励" }],
  slots: {
    // 窄屏：主列顶部横铺条（md+ 隐藏，由 home.rail 承担）
    "home.after-header": renderCheckinBar,
    // 宽桌：右栏签到卡（xl 侧栏）
    "home.rail": renderCheckinRail,
  },
});
