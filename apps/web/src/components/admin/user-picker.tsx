import { asc } from "drizzle-orm";
import { getWebDb, users } from "@funwind/db";

/**
 * 用户定位选择器（M9.5）：原生 <datalist> 零 JS 方案——输入用户名给出候选（含 uid），
 * 提交仍是用户名，由服务端解析。data-src 列表仅 ACTIVE_LIMIT 条提示（不做全量）。
 * 服务端组件；供 badges 授予 / points 调整 / pm 筛选等处替换裸输入。
 */
export async function UserPicker({
  name,
  label,
  defaultValue = "",
  placeholder = "用户名",
  required = false,
}: {
  name: string;
  /** 无障碍标签（aria-label） */
  label: string;
  defaultValue?: string;
  placeholder?: string;
  required?: boolean;
}) {
  const suggestions = await getWebDb()
    .select({ id: users.id, username: users.username })
    .from(users)
    .orderBy(asc(users.id))
    .limit(50);

  const listId = `user-picker-${name.replace(/\W/g, "-")}`;
  return (
    <>
      <input
        name={name}
        defaultValue={defaultValue}
        placeholder={placeholder}
        required={required}
        list={listId}
        aria-label={label}
        className="w-40 rounded-lg border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
      />
      <datalist id={listId}>
        {suggestions.map((u) => (
          <option key={u.id} value={u.username}>
            uid {u.id}
          </option>
        ))}
      </datalist>
    </>
  );
}
