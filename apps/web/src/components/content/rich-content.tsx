import { renderMarkdown } from "@/lib/markdown";
import { ImageLightbox } from "./image-lightbox";

/** 净化后的正文渲染：输出由 remark/rehype 白名单管线保证（XSS 用例集见 sanitize.test.ts）。
 * M10.6d：非表情内容图挂载点击放大（lightbox 客户端组件接管，选择器保持单一来源）。 */
export function RichContent({ md, className }: { md: string | null; className?: string }) {
  if (!md || md.trim() === "") {
    return <p className="text-sm text-muted-foreground">（内容为空）</p>;
  }
  const html = renderMarkdown(md);
  return (
    <>
      <div
        className={["content-md", className].filter(Boolean).join(" ")}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <ImageLightbox selector=".content-md img:not([src*='/emoji/'])" />
    </>
  );
}
