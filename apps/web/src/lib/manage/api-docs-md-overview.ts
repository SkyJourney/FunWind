import { MANAGE_ERROR_CODES } from "./errors";
import { MANAGE_ENDPOINTS } from "./permissions";
import type { DocsOverviewSection } from "./api-docs-md";

/** 错误码、状态和响应文案直接取自管理 API 错误注册表。 */
const errorRows = Object.entries(MANAGE_ERROR_CODES).map(
  ([code, { status, message }]) => `| \`${code}\` | ${status} | ${message} |`,
);

const endpoints = Object.values(MANAGE_ENDPOINTS);
const readEndpoints = endpoints.filter(({ access }) => access === "read");
const writeEndpoints = endpoints.filter(({ access }) => access === "write");
const domains = new Set(endpoints.map(({ domain }) => domain));
const readDomains = new Set(readEndpoints.map(({ domain }) => domain));
const writeDomains = new Set(writeEndpoints.map(({ domain }) => domain));

export const DOCS_OVERVIEW: readonly DocsOverviewSection[] = [
  {
    slug: "docs-overview",
    nav: "总述",
    md: [
      "## 总述",
      "",
      `管理 REST API 供脚本和自动化使用。当前目录覆盖 ${domains.size} 个域，共 ${endpoints.length} 个端点（${readEndpoints.length} 读、${writeEndpoints.length} 写）。M20.3 Step 5 新增 19 个端点（7 读、12 写）。本页仅供阅读，写入默认关闭。`,
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
      `- 签发时各域默认禁止，至少选择一项可用权限。${readDomains.size} 个域有读端点，${writeDomains.size} 个域有写端点，其中 ${readDomains.size + writeDomains.size - domains.size} 个域同时提供读写端点。令牌身份、站点统计、审计日志、邮件日志、推送日志仅读，私信域仅写。统计、审计、邮件、推送四域各自授权。`,
      "- 只读档授予该域的全部读端点，读写档授予该域的全部读、写端点（仅写的私信域只授予写端点）。签发按整档校验，缺少任一端点的全局权限会拒绝该次签发，不会跳过端点部分签发。",
      "- 角色域读写档 `roles:write` 同时包含角色管理和[用户角色绑定／解绑](#ep-users-role-assign)，所以签发还须具备 `admin.users`，仅具备管理员基础资格不能签发此档；可选择 `roles:read`。`users:write` 不包含这两个角色端点。",
      "- 域档位只用于签发。令牌实际保存签发时可授予的精确端点 ID 快照，不随同域增加端点或持有人提权而自动扩大。快照不可原地编辑；需要调整时换发并吊销旧令牌。",
      "- 生效权限是**令牌端点快照 ∩ 持有人实时资格与业务权限 ∩ 服务层资源及字段权限**。持有人必须同时具备 `site.admin` 和 `admin.roles`；被撤下管理员、全站封禁或申请注销时会联动吊销。通过入口门禁不代表可以操作任何目标。六个角色写端点在事务内再复核凭证及当前授权，先提交的撤权或吊销也会阻止回放；其他端点不保证中止已经通过门禁的在途请求。",
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
      "- 写请求使用 `Content-Type: application/json`（允许媒体类型参数）和 UTF-8 JSON。实际正文最多 16 KiB，即使没有 `Content-Length` 也会检查。正文按端点严格校验，通常是对象。[设置分组更新](#ep-settings-update)的 `nav`、`links` 直接接收数组，此数组表示单个配置值，不是批量请求。数字路径 ID 必须是十进制正安全整数，字符串键按端点规则校验。",
      "- 除[触发运维任务](#ep-ops-trigger)外，写端点都要求 `Idempotency-Key`。键长为 16–128 个 ASCII 字符，只使用英文字母、数字和 `.`、`_`、`:`、`-`。为每个新的业务意图生成新键，重试同一次操作时使用同一令牌、端点、目标、请求参数和键。",
      "- 幂等键按令牌和端点隔离，指纹包含目标（含路径中的字符串键）、请求参数和适用的版本条件。新指纹不区分 JSON 对象键顺序，但保留数组顺序；使用旧回执时请保留原字段顺序。成功提交后的 24 小时内，请求通过当前入口门禁和适用的事务外校验后，同键同指纹会返回原成功响应，跳过目标加锁和业务执行。同键不同指纹返回 `idempotency_conflict`（409）。回放仍可能产生新的调用审计。",
      "- 对使用幂等键的端点，回放窗口从成功写入计算。超过 24 小时应先确认结果，再决定是否发起新操作。实际变更、变更审计、事务事件（适用时）和成功结果一并提交，失败回滚。敏感凭证、幂等键、帖子正文和原始请求体不写入审计。",
      "- 运维触发仍受通用写门禁和频控约束，但不使用幂等键。HTTP 202 仅代表管线已受理，不代表已执行或成功；遇到断连、超时或 `ops_unavailable`（503）不能据此断定未受理。先核对运行台账，再决定是否重试。",
    ].join("\n"),
  },
  {
    slug: "docs-envelope",
    nav: "统一信封与错误码",
    md: [
      "## 统一信封与错误码",
      "",
      '成功响应使用 `{ "ok": true, "data": … }`，通常返回 HTTP 200。[运维触发](#ep-ops-trigger)在管线受理后返回 202。失败响应使用对应 HTTP 状态和 `{ "error": { "code": "…", "message": "…" } }`。API 信封响应使用 `Cache-Control: private, no-store`。',
      "",
      "| 错误码 | HTTP | 响应文案 |",
      "|---|---|---|",
      ...errorRows,
      "",
      "### 分页约定",
      "",
      "只有分页端点接受 `page`（整数 ≥1，默认 1）与 `size`（10 / 20 / 50 / 100）；非法值返回 `bad_request`（400）。默认每页 20 条的端点：用户、内容、举报、公告、邀请码、投票、积分台账、运维运行历史。默认每页 50 条的端点：审计日志、邮件日志、推送日志、表情列表（只分页表情条目，不分页表情组）。分页响应结构见各端点。",
    ].join("\n"),
  },
];
