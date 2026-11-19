import { MANAGE_ERROR_CODES } from "./errors";
import { MANAGE_ENDPOINTS } from "./permissions";
import type { DocsOverviewSection } from "./api-docs-md";

/** 错误码、状态和响应文案直接取自管理 API 错误注册表。 */
const errorRows = Object.entries(MANAGE_ERROR_CODES).map(
  ([code, { status, message }]) => `| \`${code}\` | ${status} | ${message} |`,
);

const endpoints = Object.values(MANAGE_ENDPOINTS);
const reads = endpoints.filter(({ access }) => access === "read").length;

export const DOCS_OVERVIEW: readonly DocsOverviewSection[] = [
  {
    slug: "docs-overview",
    nav: "总述",
    md: [
      "## 总述",
      "",
      `管理 REST API 供脚本和自动化使用。本页说明 ${reads} 个读端点和 ${endpoints.length - reads} 个写端点；仅供阅读，不提供在线调用。写入默认关闭。`,
      "",
      "**谁可以读这份文档？** 使用站点会话登录，并满足站点管理员资格（同时具备 `site.admin` 和 `admin.roles`，账号可用且未被全站封禁）。未登录会跳转到登录页；登录后不满足资格返回 404。API 令牌不能替代浏览器会话来阅读文档。",
      "",
      "1. 先读「鉴权与权限快照」，按用途签发令牌。",
      "2. 写操作前读「写入与重试」，再在导航中选择对应端点。",
      "3. 排障可查「统一信封与错误码」，并到后台审计日志按 `targetType=manage_api` 查看调用记录。",
    ].join("\n"),
  },
  {
    slug: "docs-auth",
    nav: "鉴权与权限快照",
    md: [
      "## 鉴权与权限快照",
      "",
      "### 签发和传递令牌",
      "",
      "在[后台 API 令牌页](/admin/api-tokens)签发。有效期可选 30 / 90 / 180 / 365 天（默认 90），每位管理员最多持有 5 个有效令牌。明文仅显示一次，服务端只存哈希；遗失时请吊销并重新签发。",
      "",
      "- `fw_at_`：历史令牌，只保留固定的九个 GET 端点，既不能写入，也不会获得未来新增的读端点。",
      "- `fw_at2_`：新版签发统一使用此格式，哪怕只勾选读权限。前缀必须与服务端保存的授权模型相符；退回旧版时，新前缀不被识别，会返回 401。",
      "",
      "将完整令牌置于 `Authorization: Bearer <token>` 请求头。以下示例从环境变量读取令牌；身份接口仍需签发 `identity:read`。",
      "",
      "```bash",
      'curl -H "Authorization: Bearer ${FUNWIND_API_TOKEN}" \\',
      '  "https://<站点>/api/manage/whoami"',
      "```",
      "",
      "### 域档位与生效权限",
      "",
      "- 新令牌各域默认禁止，签发时至少勾选一项可用权限。只读授予该域可签发的读端点；读写同时授予可签发的读、写端点。目前内容治理、举报、用户治理、公告、活动、邀请码六个域有写端点。统计、审计、邮件、推送四域独立选择，不因共用 `admin.logs` 而合并授权。",
      "- 域档位只用于签发。令牌实际保存签发时可授予的精确端点 ID 快照，不随同域增加端点或持有人提权而自动扩大。快照不可原地编辑；需要调整时换发并吊销旧令牌。",
      "- 生效权限是**令牌端点快照 ∩ 持有人实时资格与业务权限 ∩ 服务层资源及字段权限**。持有人必须同时具备 `site.admin` 和 `admin.roles`；被撤下管理员、全站封禁或申请注销时会联动吊销。通过入口门禁不代表可以操作任何目标，也不保证随后撤权会中止已经通过门禁的在途请求。",
      "- 持有人或令牌缺少入口权限时返回 `forbidden`；目标不存在或目标级越权时统一返回 `not_found`。凭证缺失、无效、过期或已吊销时返回 `unauthorized`。",
      "",
      "### 频控和调用记录",
      "",
      "- 可信 IP 每分钟 120 次，同一令牌每分钟 60 次；写请求另有每令牌每分钟 10 次、每用户每分钟 30 次的限制。频控为进程内统计，只承诺单实例语义。超限返回 429，`Retry-After` 为建议等待的秒数。",
      "- 除 `whoami` 外，请求通过入口门禁后、处理前写入 `api.<端点 ID>` 调用审计，并节流更新令牌最后使用时间与 IP。读调用记录可包含查询摘要；写调用仅记录受控的令牌尾号与请求关联 ID 等元信息，不记原始请求参数。调用记录不代表业务成功。",
    ].join("\n"),
  },
  {
    slug: "docs-writes",
    nav: "写入与重试",
    md: [
      "## 写入与重试",
      "",
      "- 写入口默认关闭；只有部署方显式设置 `MANAGE_API_WRITES=on` 才启用。具备调用资格时，停写返回 `writes_disabled`（503），不影响读取或已经提交的变更。",
      "- 全部写端点均只接收 `Content-Type: application/json`（允许媒体类型参数），正文为 UTF-8 严格 JSON 对象，不接受未知字段、数组或批量请求；实际正文最多 16 KiB，即使没有 `Content-Length` 也会检查。路径 ID 必须是十进制正安全整数。",
      "- 全部写端点都必须传 `Idempotency-Key`。键长为 16–128 个 ASCII 字符，只使用英文字母、数字和 `.`、`_`、`:`、`-`。为每个新的业务意图生成新键；重试同一次操作时使用同一令牌、同一端点、同一键和同一请求参数。",
      "- 幂等键按令牌和端点隔离，并绑定规范化后的目标 ID 与参数。成功提交后的 24 小时内，重新通过入口与资源权限检查且请求相同，会返回原成功响应，不再次变更、写变更审计或派发事件；同键用于不同目标或参数时返回 `idempotency_conflict`（409）。成功回放也可能留下新的调用审计。",
      "- 回放窗口从成功写入计算；超过 24 小时不保证回放，先通过读取或后台确认结果，再决定是否发起新操作，不要盲目重试。失败回滚，不保存成功结果。",
      "- 成功结果、实际业务变更、变更审计和事务事件（适用时）一并提交。敏感凭证、幂等键、帖子正文和原始请求体不写入审计。",
    ].join("\n"),
  },
  {
    slug: "docs-envelope",
    nav: "统一信封与错误码",
    md: [
      "## 统一信封与错误码",
      "",
      '端点成功时返回 HTTP 200 和 `{ "ok": true, "data": … }`；失败时返回对应 HTTP 状态及 `{ "error": { "code": "…", "message": "…" } }`。API 信封响应使用 `Cache-Control: private, no-store`。',
      "",
      "| 错误码 | HTTP | 响应文案 |",
      "|---|---|---|",
      ...errorRows,
      "",
      "### 分页约定",
      "",
      "分页查询参数 `page` 默认 1，`size` 默认 20，仅接受 10 / 20 / 50 / 100。内容列表和用户列表返回 `{ items, total, page, totalPages }`；审计日志返回 `{ items, total }`，邮件和推送日志还包含 `summary`。",
    ].join("\n"),
  },
];
