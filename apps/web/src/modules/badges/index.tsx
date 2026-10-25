import { fileUrl } from "@/lib/files";
import { userBadgesOf, type UserBadgeView } from "@/lib/badges/service";
import { defineModule, type SlotContext } from "../kernel/types";

/**
 * 荣誉徽章模块（M7）：badges / user_badges 的展示位 + 后台手动授予（app/admin/badges，零权限语义）。
 * 展示位：`profile.header`（资料页徽章卡）与 `thread.user-badge`（帖子页作者行的小图标串）。
 * 无徽章 / 模块停用 → 渲染 null（Slot 层自动过滤）。图标缺失（旧站磁盘丢失的 4 枚）用首字占位。
 */

function BadgeIcon({ b, size }: { b: UserBadgeView; size: string }) {
  return b.iconKey ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={fileUrl(b.iconKey)}
      alt={b.name}
      title={b.name}
      width={20}
      height={20}
      className={size}
    />
  ) : (
    <span
      title={b.name}
      className={`${size} inline-flex items-center justify-center rounded-full bg-primary/15 text-[10px] font-medium text-primary`}
    >
      {b.name.slice(0, 1)}
    </span>
  );
}

async function renderProfileBadges(ctx: SlotContext) {
  if (!ctx.userId) return null;
  const list = await userBadgesOf(ctx.userId);
  if (list.length === 0) return null;
  return (
    <div className="rounded-xl border bg-card px-4 py-3">
      <p className="mb-2 text-xs text-muted-foreground">荣誉徽章（{list.length}）</p>
      <ul className="flex flex-wrap gap-2">
        {list.map((b) => (
          <li
            key={b.badgeId}
            className="flex items-center gap-1.5 rounded-lg border bg-background px-2 py-1 text-xs"
            title={b.description || b.name}
          >
            <BadgeIcon b={b} size="size-4" />
            <span className="font-medium">{b.name}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

async function renderThreadBadges(ctx: SlotContext) {
  if (!ctx.userId) return null;
  const list = await userBadgesOf(ctx.userId);
  if (list.length === 0) return null;
  return (
    <span className="inline-flex items-center gap-0.5" data-slot-content="thread-user-badges">
      {list.map((b) => (
        <BadgeIcon key={b.badgeId} b={b} size="size-[18px]" />
      ))}
    </span>
  );
}

export const badgesModule = defineModule({
  id: "badges",
  description:
    "荣誉徽章：团队徽章与旧勋章的展示（profile.header 徽章卡 / thread.user-badge 作者行图标位）；后台手动授予（badge.awarded 事件经 outbox）。",
  slots: {
    "profile.header": renderProfileBadges,
    "thread.user-badge": renderThreadBadges,
  },
});
