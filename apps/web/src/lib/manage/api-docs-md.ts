import { MANAGE_ENDPOINTS, MANAGE_PERMISSION_DOMAINS, getManageEndpoint } from "./permissions";
import type {
  ManageEndpointDefinition,
  ManageEndpointId,
  ManagePermissionDomain,
} from "./permissions";
import { MANAGE_ERROR_CODES, type ManageErrorCode } from "./errors";
import { DOCS_OVERVIEW } from "./api-docs-md-overview";
import { ENDPOINT_DOCS } from "./api-docs-md-endpoints";

export type DocsOverviewSection = { slug: string; nav: string; md: string };

/** 仅维护端点说明；方法、路径、域和令牌权限不在文案中重复定义。 */
export type EndpointDoc = {
  slug: string;
  nav: string;
  restrictions?: string;
  errors?: readonly ManageErrorCode[];
  lines: readonly string[];
};

type DocsEndpointSection = DocsOverviewSection & {
  id: ManageEndpointId;
  endpoint: ManageEndpointDefinition;
};

const COMMON_ERRORS = ["unauthorized", "forbidden", "rate_limited", "internal"] as const;
const WRITE_ERRORS = [
  "bad_request",
  "not_found",
  "idempotency_conflict",
  "payload_too_large",
  "unsupported_media_type",
  "writes_disabled",
] as const;

/** 用同一端点定义生成正文元信息和导航方法徽标。 */
function endpointSection(id: ManageEndpointId): DocsEndpointSection {
  const endpoint = getManageEndpoint(id);
  const { method, path, domain, access, permission } = endpoint;
  const { slug, nav, restrictions, errors = [], lines }: EndpointDoc = ENDPOINT_DOCS[id];
  const errorCodes = [
    ...new Set<ManageErrorCode>([
      ...COMMON_ERRORS,
      ...(access === "write" ? WRITE_ERRORS : []),
      ...errors,
    ]),
  ];
  const md = [
    `### ${nav}`,
    "",
    "| 项目 | 端点信息 |",
    "|---|---|",
    `| 请求 | \`${method} ${path}\` |`,
    `| 数据域 | ${MANAGE_PERMISSION_DOMAINS[domain]} |`,
    `| 令牌权限 | \`${domain}:${access}\`（${access === "read" ? "读" : "写"}）；端点 ID：\`${id}\` |`,
    `| 持有人全局权限 | \`site.admin\` + \`admin.roles\`${permission ? ` + \`${permission}\`` : ""} |`,
    ...(restrictions ? [`| 资源或字段限制 | ${restrictions} |`] : []),
    "",
    ...lines,
    "",
    `**错误**（见[统一信封与错误码](#docs-envelope)）：${errorCodes.map((code) => `\`${code}\`（${MANAGE_ERROR_CODES[code].status}）`).join("、")}。`,
  ].join("\n");
  return { id, endpoint, slug, nav, md };
}

const endpoints = (Object.keys(MANAGE_ENDPOINTS) as ManageEndpointId[]).map(endpointSection);
const domains = (Object.keys(MANAGE_PERMISSION_DOMAINS) as ManagePermissionDomain[]).map((id) => ({
  id,
  title: MANAGE_PERMISSION_DOMAINS[id],
  sections: endpoints.filter(({ endpoint }) => endpoint.domain === id),
}));

/** 页面正文、桌面导航和移动导航共用锚点；保留旧审计日志总节锚点。 */
export const DOCS_SECTIONS = [
  ...DOCS_OVERVIEW,
  ...domains.flatMap(({ id, title, sections }) => [
    { slug: `docs-${id === "audit-logs" ? "logs" : id}`, md: `## ${title}` },
    ...sections,
  ]),
];

/** 导航展示概览和端点；数据域标题不作为可点条目。 */
export function docsNavGroups() {
  const intro = DOCS_OVERVIEW.map(({ slug, nav }) => ({ slug, nav }));
  return [
    { group: "概览", items: intro },
    ...domains.map(({ id, title, sections }) => ({
      domain: id,
      group: title,
      items: sections.map(({ id, slug, nav, endpoint: { method, access } }) => ({
        id,
        slug,
        nav,
        method,
        access,
      })),
    })),
  ];
}
