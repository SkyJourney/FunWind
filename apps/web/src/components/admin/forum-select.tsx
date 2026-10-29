import { getForumTree } from "@/lib/authz/snapshot";

/**
 * 板块选择器（M9.5）：服务端组件 <select>，层级缩进用 U+00A0（全角空格在等宽场景宽度不稳），
 * 板块多时层级仍可读；供 users/[uid] 角色作用域、forums 父级、review/reports 板块筛选、
 * authz/forum 切换器等处统一替换裸输入/各页手写下拉。
 * 可选 kindFilter：目录筛选只列板块（forum），管理场景传 all 全列。
 */
export async function ForumSelect({
  name,
  label,
  defaultValue,
  allLabel,
  kindFilter = "all",
  className = "rounded-lg border border-input bg-background px-2 py-1.5 text-sm",
  required = false,
}: {
  name: string;
  /** 无障碍标签（aria-label） */
  label: string;
  /** 选中值；未匹配（含 undefined）时落到 allOption */
  defaultValue?: number | null;
  /** 首选项文案（如「全局」「全部板块」）；不传则无首选项 */
  allLabel?: string;
  kindFilter?: "all" | "forum";
  className?: string;
  required?: boolean;
}) {
  const tree = await getForumTree();
  const rows = tree.all().filter((f) => (kindFilter === "forum" ? f.kind === "forum" : true));
  return (
    <select
      name={name}
      defaultValue={defaultValue !== null && defaultValue !== undefined ? String(defaultValue) : ""}
      aria-label={label}
      required={required}
      className={className}
    >
      {allLabel !== undefined && <option value="">{allLabel}</option>}
      {rows.map((f) => (
        <option key={f.id} value={f.id}>
          {" ".repeat(Math.max(0, (f.depth - 1) * 2))}
          {f.name}
        </option>
      ))}
    </select>
  );
}
