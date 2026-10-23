import { renderMarkdown } from "@/lib/markdown";

/** 净化后的正文渲染：输出由 remark/rehype 白名单管线保证（XSS 用例集见 sanitize.test.ts） */
export function RichContent({ md, className }: { md: string | null; className?: string }) {
  if (!md || md.trim() === "") {
    return <p className="text-sm text-muted-foreground">（内容为空）</p>;
  }
  const html = renderMarkdown(md);
  return (
    <div
      className={["content-md", className].filter(Boolean).join(" ")}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
