"use client";

import { useEffect, useRef } from "react";

/** 发帖表单的投票区显隐开关（勾选「发起投票」展开字段；M10） */
export function PollFieldsToggle() {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const toggle = ref.current;
    if (!toggle) return;
    const form = toggle.closest("form");
    const fields = form?.querySelector("[data-poll-fields]");
    if (!fields) return;
    const sync = () => fields.classList.toggle("hidden", !toggle.checked);
    toggle.addEventListener("change", sync);
    return () => toggle.removeEventListener("change", sync);
  }, []);
  return <input type="checkbox" name="pollEnabled" value="on" ref={ref} />;
}
