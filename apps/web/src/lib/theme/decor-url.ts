/** 主题素材公开地址（decor 池唯一出口，与 /brand/decor 路由的 ?file= 契约一致）。 */
export function decorUrl(file: string): string {
  return `/brand/decor?file=${encodeURIComponent(file)}`;
}
