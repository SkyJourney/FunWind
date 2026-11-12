import { renderMarkdown } from "@/lib/markdown";
import { ContentImageFade } from "@/components/content/content-image-fade";

/** 净化后的正文渲染：输出由 remark/rehype 白名单管线保证（XSS 用例集见 sanitize.test.ts）。
 * 图片点击放大由页面顶层的 <ImageLightbox /> 统一接管（勿在楼层内重复渲染）；
 * 视口外图片的懒加载与淡入由 <ContentImageFade /> 委托处理（M16 Step 3）。 */
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
      <ContentImageFade />
    </>
  );
}
