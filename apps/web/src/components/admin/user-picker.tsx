"use client";

import { useEffect, useId, useRef, useState } from "react";

/**
 * 用户选择器（M19 D4 搜索化）：输入即搜（≥1 字符防抖 250ms 调 /api/admin/users/search），
 * 候选下拉展示「用户名 (uid)」。提交仍是 username 字符串（name 与筛选参数对齐），
 * 服务端语义不变（纯数字=uid 等值，否则用户名精确/包含匹配）——调用点 props 兼容。
 * 无 JS 时退化成纯文本输入（服务端照常解析），只是没有候选下拉。
 */
export function UserPicker({
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
  const [value, setValue] = useState(defaultValue);
  const [items, setItems] = useState<{ id: number; username: string; label: string }[]>([]);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    const q = value.trim();
    if (!q) return;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/admin/users/search?q=${encodeURIComponent(q)}`);
        if (!res.ok) {
          setItems([]);
          return;
        }
        const data: { items: { id: number; username: string; label: string }[] } = await res.json();
        setItems(data.items ?? []);
        setOpen(true);
      } catch {
        setItems([]);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [value]);

  // 点组件外收起候选
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  return (
    <div ref={boxRef} className="relative">
      <input
        name={name}
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          setValue(v);
          if (!v.trim()) {
            setItems([]);
            setOpen(false);
          }
        }}
        onFocus={() => items.length > 0 && setOpen(true)}
        placeholder={placeholder}
        required={required}
        aria-label={label}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        autoComplete="off"
        className="w-40 rounded-lg border bg-background px-2.5 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring"
      />
      {open && items.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          aria-label={`${label}候选`}
          className="absolute z-20 mt-1 max-h-60 w-56 overflow-auto rounded-lg border bg-card shadow-md"
        >
          {items.map((u) => (
            <li key={u.id}>
              <button
                type="button"
                role="option"
                aria-selected={u.username === value}
                onClick={() => {
                  setValue(u.username);
                  setOpen(false);
                }}
                className="block w-full truncate px-2.5 py-1.5 text-left text-xs hover:bg-accent"
              >
                {u.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
