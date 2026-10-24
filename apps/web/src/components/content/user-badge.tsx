import Link from "next/link";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

/**
 * 作者徽标。已注销账号（含迁移生成的“已注销用户”占位账号）一律显示「已注销」，
 * 不显示占位用户名里的 uid、也不提供个人页链接（占位账号不开个人页）。
 */
export function UserBadge({
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

  const inner = (
    <>
      <Avatar className="size-5">
        <AvatarFallback className={gone ? "bg-muted text-muted-foreground" : "bg-primary/15"}>
          {initial}
        </AvatarFallback>
      </Avatar>
      <span className={gone ? "text-muted-foreground italic" : "font-medium"}>{display}</span>
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
