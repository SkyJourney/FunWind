import Link from "next/link";

/** 通用分页：?page=N 追加到 basePath（含已有 query 的拼接由调用方处理 type 等参数） */
export function Pagination({
  basePath,
  page,
  totalPages,
}: {
  basePath: string;
  page: number;
  totalPages: number;
}) {
  if (totalPages <= 1) return null;
  const sep = basePath.includes("?") ? "&" : "?";
  const href = (p: number) => `${basePath}${sep}page=${p}`;
  const pages: (number | "…")[] = [];
  for (let p = 1; p <= totalPages; p++) {
    if (p === 1 || p === totalPages || Math.abs(p - page) <= 2) pages.push(p);
    else if (pages[pages.length - 1] !== "…") pages.push("…");
  }

  return (
    <nav className="flex flex-wrap items-center justify-center gap-1.5 py-4" aria-label="分页">
      {page > 1 && (
        <Link className="rounded-md border px-3 py-1 text-sm hover:bg-accent" href={href(page - 1)}>
          上一页
        </Link>
      )}
      {pages.map((p, i) =>
        p === "…" ? (
          <span key={`e${i}`} className="px-2 text-muted-foreground">
            …
          </span>
        ) : p === page ? (
          <span
            key={p}
            className="rounded-md bg-primary px-3 py-1 text-sm text-primary-foreground"
            aria-current="page"
          >
            {p}
          </span>
        ) : (
          <Link
            key={p}
            className="rounded-md border px-3 py-1 text-sm hover:bg-accent"
            href={href(p)}
          >
            {p}
          </Link>
        ),
      )}
      {page < totalPages && (
        <Link className="rounded-md border px-3 py-1 text-sm hover:bg-accent" href={href(page + 1)}>
          下一页
        </Link>
      )}
    </nav>
  );
}
