import { Avatar, AvatarFallback } from "@/components/ui/avatar";

/** 作者徽标：孤儿作者（users 表无对应行）渲染「已注销」——81 个真实回帖作者的场景 */
export function UserBadge({ name, hint }: { name: string | null; hint?: string }) {
  const isOrphan = !name;
  const display = isOrphan ? "已注销" : name;
  const initial = isOrphan ? "销" : display.slice(0, 1).toUpperCase();

  return (
    <span className="inline-flex items-center gap-1.5 text-sm" title={hint}>
      <Avatar className="size-5">
        <AvatarFallback className={isOrphan ? "bg-muted text-muted-foreground" : "bg-primary/15"}>
          {initial}
        </AvatarFallback>
      </Avatar>
      <span className={isOrphan ? "text-muted-foreground italic" : "font-medium"}>{display}</span>
    </span>
  );
}
