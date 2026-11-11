"use client";

export function NavigationDemo() {
  return (
    <button
      type="button"
      className="rounded border px-3 py-2 text-sm"
      onClick={() => window.dispatchEvent(new Event("funwind:motion-lab"))}
    >
      开启持久导航实验面板
    </button>
  );
}
