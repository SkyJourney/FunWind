import Link from "next/link";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { avatarKeyOf } from "@/lib/queries/users";
import { fileUrl } from "@/lib/files";
import { Slot } from "@/modules/kernel/slot";

/**
 * 作者徽标（M7 起为异步服务端组件）。已注销账号（含迁移生成的“已注销用户”占位账号）
 * 一律显示「已注销」，不显示占位用户名里的 uid、也不提供个人页链接（占位账号不开个人页）。
 * M7：头像（有则显示，无则首字母，M7-3）+ 荣誉徽章位（thread.user-badge 槽位，
 * 由徽章模块注册；模块停用或作者无徽章时整段不渲染）。
 */
export async function UserBadge({
  uid,
  name,
  deleted = false,
}: {
  uid?: number;
  name: string | null;
  deleted?: boolean;
}) {
  const gone = deleted || !name;
  const display = gone ? "已注销" : name;
  const initial = gone ? "销" : display.slice(0, 1).toUpperCase();
  const avatarKey = !gone && uid !== undefined ? await avatarKeyOf(uid) : null;

  const inner = (
    <>
      <Avatar className="size-5">
        {avatarKey && <AvatarImage src={fileUrl(avatarKey)} alt={display} />}
        <AvatarFallback className={gone ? "bg-muted text-muted-foreground" : "bg-primary/15"}>
          {initial}
        </AvatarFallback>
      </Avatar>
      <span className={gone ? "text-muted-foreground italic" : "font-medium"}>{display}</span>
      {uid !== undefined && !gone && <Slot name="thread.user-badge" ctx={{ userId: uid }} />}
    </>
  );

  return gone || uid === undefined ? (
    <span
      className="inline-flex items-center gap-1.5 text-sm"
      title={gone ? "作者账号已注销" : undefined}
    >
      {inner}
    </span>
  ) : (
    <Link
      href={`/u/${uid}`}
      className="inline-flex items-center gap-1.5 text-sm hover:text-primary"
    >
      {inner}
    </Link>
  );
}
