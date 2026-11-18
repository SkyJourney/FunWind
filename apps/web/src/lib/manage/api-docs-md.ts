/**
 * 管理 REST API 在线文档的内容源（M20.1，markdown + 站内渲染器管线）：
 * 每节一段 markdown，页面用 RichContent（renderMarkdown：GFM 表格 / 代码围栏 / sanitize）统一渲染。
 * 形态说明：md 以行数组 + join("\n") 承载——内容含代码围栏（三反引号）与行内反引号，
 * 模板字符串无法安全承载；单引号串行数组是结构最稳的形态。
 * 同步责任：端点实现（app/api/manage/**）变更时同步本文件与 docs/MANAGE-API.md。
 */

import { DOCS_SECTIONS_PART1 } from "./api-docs-md-overview";
import { DOCS_SECTIONS_PART2 } from "./api-docs-md-endpoints";

export interface DocsSection {
  /** 节锚点 id（页面 section id 与左树导航 href 共用） */
  slug: string;
  /** 左树导航条目名（语义功能名，不使用接口路径） */
  nav: string;
  /** 左树分组名（概览组 / 功能域组） */
  group: string;
  /** 是否携带 GET 方法徽标（概览组与域说明段无） */
  withMethod?: boolean;
  /** 资格外权限徽标文本（与实现一致；缺省 = 仅站点管理员资格） */
  permission?: string;
  /** 端点路径（接口节元信息表展示） */
  path?: string;
  md: string;
}

// 内容拆两个部分文件（行数软限 600）：概览组+站点域 / 用户+内容+日志域；此处组装导出
export const DOCS_SECTIONS: DocsSection[] = [...DOCS_SECTIONS_PART1, ...DOCS_SECTIONS_PART2];

/** 左树分组结构（由 DOCS_SECTIONS 归组派生；域说明段不作为导航条目——导航只到接口粒度） */
export interface DocsNavGroup {
  group: string;
  items: { slug: string; nav: string; withMethod?: boolean; permission?: string }[];
}

export function docsNavGroups(): DocsNavGroup[] {
  const groups: DocsNavGroup[] = [];
  for (const section of DOCS_SECTIONS) {
    if (section.group === "功能域" && !section.withMethod) continue;
    let g = groups.find((x) => x.group === section.group);
    if (!g) {
      g = { group: section.group, items: [] };
      groups.push(g);
    }
    g.items.push({
      slug: section.slug,
      nav: section.nav,
      withMethod: section.withMethod,
      permission: section.permission,
    });
  }
  return groups;
}
