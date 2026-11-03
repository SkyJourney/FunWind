import ts from "typescript";
import { memberName, sourceSymbols, unwrap, type SourceSymbols } from "./content-source-symbols";
import type { Sources } from "./source-graph";

const PROCESSOR = "lib/uploads/process-image.ts";
const IMAGE_ASSET = "lib/uploads/image-asset.ts";
const TABLE = "accountDeletionRequests";

function location(node: ts.Node): string {
  const file = node.getSourceFile();
  return `${file.fileName}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;
}

function typePosition(node: ts.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isTypeNode(parent)) return true;
    if (ts.isStatement(parent)) break;
  }
  return false;
}

/** G11 约束具体值来源而不是模块依赖；ProcessError 与类型、其他独立 sharp 管线不受限。 */
export function imageSourceProblems(input: Sources): string[] {
  const symbols = sourceSymbols(input);
  const definitions: string[] = [];
  const problems = new Set<string>();
  for (const [path, file] of symbols.files) {
    for (const name of symbols.exportsOf(path)) {
      if (
        path !== PROCESSOR &&
        symbols.contains(symbols.exportedOrigin(path, name, new Set()), PROCESSOR, "processImage")
      )
        problems.add(`${path}: 禁止转发 processImage（${name}）`);
    }
    const visit = (node: ts.Node) => {
      if (
        (ts.isFunctionDeclaration(node) && node.body && node.name?.text === "processImage") ||
        (ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.name.text === "processImage" &&
          node.initializer &&
          (ts.isArrowFunction(unwrap(node.initializer)) ||
            ts.isFunctionExpression(unwrap(node.initializer))))
      )
        definitions.push(path);
      if (path !== PROCESSOR && path !== IMAGE_ASSET && !typePosition(node)) {
        if (
          ts.isIdentifier(node) ||
          ts.isPropertyAccessExpression(node) ||
          ts.isElementAccessExpression(node)
        ) {
          const value = symbols.origin(node);
          const direct = value?.module === PROCESSOR && value.name === "processImage";
          const parent = node.parent;
          const namespaceEscape =
            value?.name === "*" &&
            !ts.isImportDeclaration(parent) &&
            !ts.isNamespaceImport(parent) &&
            !ts.isVariableDeclaration(parent) &&
            !ts.isBindingElement(parent) &&
            !ts.isParameter(parent) &&
            !ts.isPropertyAccessExpression(parent) &&
            !(
              ts.isElementAccessExpression(parent) &&
              ts.isStringLiteralLike(parent.argumentExpression)
            ) &&
            symbols.contains(value, PROCESSOR, "processImage");
          if (direct || namespaceEscape)
            problems.add(`${location(node)}: processImage 值只能由 ${IMAGE_ASSET} 使用`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  if (definitions.length !== 1 || definitions[0] !== PROCESSOR)
    problems.add(
      `processImage 定义必须唯一位于 ${PROCESSOR}，实际为 ${definitions.sort().join(", ") || "无"}`,
    );
  return [...problems].sort();
}

export interface IdentityException {
  path: string;
  owner: string;
  states: string[][];
  reason: string;
  lock?: boolean;
}

const CLOSING = [["completed", "pending"]];
const MACHINE = [["completed", "pending"], ["completed"], ["pending"]];

// 例外只授权这个文件的这个命名函数及精确状态集合，绝不豁免整文件或依赖行号。
export const IDENTITY_EXCEPTIONS: IdentityException[] = [
  ...["publicUserDeleted", "userNotDeleted"].map((owner) => ({
    path: "lib/identity-expr.ts",
    owner,
    states: [["completed"]],
    reason: "公共公开身份表达式唯一实现。",
  })),
  {
    path: "lib/identity-expr.ts",
    owner: "userNotClosing",
    states: CLOSING,
    reason: "公共写资格表达式唯一实现。",
  },
  {
    path: "lib/identity.ts",
    owner: "lockActiveUserInTx",
    states: CLOSING,
    reason: "单用户 IO 锁需区分 missing/inactive/closing，保留原锁序。",
  },
  ...[
    "readCurrentSessionUser",
    "getClosureAccess",
    "createSessionInTx",
    "replaceCredentialsAndCreateSessionInTx",
  ].map((owner) => ({
    path: "lib/auth/session.ts",
    owner,
    states: owner === "getClosureAccess" ? MACHINE : CLOSING,
    reason: "会话有效性、短权限注销凭据或持锁凭据轮换的安全复核，不是业务公开身份查询。",
  })),
  ...["issueEmailTokenInTx", "consumeEmailTokenInTx"].map((owner) => ({
    path: "lib/auth/tokens.ts",
    owner,
    states: CLOSING,
    reason: "令牌签发与原子消费须在既有锁序内独立拒绝注销账号。",
  })),
  ...[
    "createRequestInTx",
    "issueAccountDeletionEmailToken",
    "startOrOpenAccountDeletionWithPassword",
  ].map((owner) => ({
    path: "lib/auth/account-deletion.ts",
    owner,
    states: owner === "createRequestInTx" ? MACHINE : [["completed"], ["pending"]],
    reason: "注销状态机区分重复申请、已完成与复用 pending 访问凭据。",
  })),
  ...[
    "createClosureAccessInTx",
    "cancelAccountDeletion",
    "completeAccountDeletion",
    "processDueAccountDeletions",
  ].map((owner) => ({
    path: "lib/auth/account-deletion.ts",
    owner,
    states: [["pending"]],
    reason: "注销状态机仅允许待处理请求签发凭据、撤销、到期完成或失败重试。",
  })),
  ...["submitAppealAsUser", "submitAppealWithPassword"].map((owner) => ({
    path: "lib/authz/appeals.ts",
    owner,
    states: [["pending"]],
    reason: "申诉保留独立 pending-only 规则，不能机械改为 pending/completed 资格判断。",
  })),
  {
    path: "lib/pm/service.ts",
    owner: "sendMessage",
    states: CLOSING,
    lock: true,
    reason: "私信先升序锁双方用户，再对收件方注销行 FOR UPDATE；不能替换为无锁公共表达式。",
  },
  {
    path: "lib/authz/subject.ts",
    owner: "loadSubject",
    states: CLOSING,
    reason: "主体独立 Promise.all 查询 closure，保留查询顺序与游客回退，不合并前置拒绝。",
  },
  {
    path: "lib/badges/service.ts",
    owner: "grantBadgeByAdmin",
    states: CLOSING,
    reason: "保留 missing/inactive 与 closing 两级错误映射，以及原无锁的查询协议。",
  },
  {
    path: "lib/authz/admin-user-views.ts",
    owner: "listAdminUsersPage",
    states: [["pending"], ["completed"]],
    reason: "治理列表主动筛选 pending/deleted 生命周期并投影排期，不是通用可写资格。",
  },
];

/** 匿名事务回调归属外层；嵌套命名函数不得继承顶层函数例外。 */
function ownerOf(node: ts.Node): string {
  for (let current: ts.Node | undefined = node; current?.parent; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) {
      return ts.isSourceFile(current.parent) ? current.name.text : `<嵌套:${current.name.text}>`;
    }
    if (ts.isFunctionExpression(current) && current.name) return `<嵌套:${current.name.text}>`;
    if (
      ts.isMethodDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current)
    )
      return `<嵌套:${current.name.getText()}>`;
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      let parent: ts.Node = current.parent;
      while (ts.isCallExpression(parent) || ts.isParenthesizedExpression(parent))
        parent = parent.parent;
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
        const statement = parent.parent.parent;
        return ts.isVariableStatement(statement) && ts.isSourceFile(statement.parent)
          ? parent.name.text
          : `<嵌套:${parent.name.text}>`;
      }
    }
  }
  return "<模块>";
}

function selectFields(
  node: ts.Node,
  symbols: SourceSymbols,
  seen = new Set<ts.Node>(),
): ts.ObjectLiteralExpression | null {
  node = unwrap(node);
  if (seen.has(node)) return null;
  const next = new Set(seen).add(node);
  if (ts.isIdentifier(node)) {
    const declaration = symbols.declaration(node);
    const variable =
      declaration && ts.isBindingElement(declaration) ? declaration.parent.parent : declaration;
    if (variable && ts.isVariableDeclaration(variable) && variable.initializer)
      return selectFields(variable.initializer, symbols, next);
  }
  if (ts.isElementAccessExpression(node)) return selectFields(node.expression, symbols, next);
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    if (
      node.expression.name.text === "select" &&
      node.arguments[0] &&
      ts.isObjectLiteralExpression(node.arguments[0])
    )
      return node.arguments[0];
    return selectFields(node.expression.expression, symbols, next);
  }
  return null;
}

function isStatus(node: ts.Node, symbols: SourceSymbols, seen = new Set<ts.Node>()): boolean {
  node = unwrap(node);
  if (seen.has(node)) return false;
  const next = new Set(seen).add(node);
  const value = symbols.origin(node);
  if (value?.module === "@funwind/db" && value.name === `${TABLE}.status`) return true;
  if (ts.isIdentifier(node)) {
    const declaration = symbols.declaration(node);
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer)
      return isStatus(declaration.initializer, symbols, next);
    if (
      declaration &&
      ts.isBindingElement(declaration) &&
      ts.isObjectBindingPattern(declaration.parent)
    ) {
      const variable = declaration.parent.parent;
      if (ts.isVariableDeclaration(variable) && variable.initializer) {
        const name = declaration.propertyName ?? declaration.name;
        if (ts.isIdentifier(name))
          return selectedStatus(variable.initializer, name.text, symbols, next);
      }
    }
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const name = memberName(node);
    if (name) return selectedStatus(node.expression, name, symbols, next);
  }
  return false;
}

function selectedStatus(
  row: ts.Node,
  name: string,
  symbols: SourceSymbols,
  seen: Set<ts.Node>,
): boolean {
  const fields = selectFields(row, symbols);
  const field = fields?.properties.find(
    (entry) =>
      entry.name &&
      (ts.isIdentifier(entry.name) || ts.isStringLiteralLike(entry.name)) &&
      entry.name.text === name,
  );
  return !!field && ts.isPropertyAssignment(field) && isStatus(field.initializer, symbols, seen);
}

function lockedQuery(node: ts.Node): boolean {
  for (
    let current: ts.Node | undefined = node.parent;
    current && !ts.isStatement(current);
    current = current.parent
  ) {
    if (
      ts.isCallExpression(current) &&
      memberName(current.expression) === "for" &&
      current.arguments[0] &&
      ts.isStringLiteralLike(current.arguments[0]) &&
      current.arguments[0].text === "update"
    )
      return true;
  }
  return false;
}

interface Predicate {
  node: ts.Node;
  states: string[];
  form: string;
  locked: boolean;
}

/** SQL 只解析真实 sql 模板/字面量 sql.raw；按表别名关联 status，字符串与 SQL 注释不充当语法。 */
function rawPredicates(node: ts.Node, symbols: SourceSymbols): Predicate[] {
  let text = "";
  if (ts.isTaggedTemplateExpression(node)) {
    const tag = symbols.origin(node.tag);
    if (tag?.module !== "drizzle-orm" || tag.name !== "sql") return [];
    if (ts.isNoSubstitutionTemplateLiteral(node.template)) text = node.template.text;
    else {
      text = node.template.head.text;
      for (const span of node.template.templateSpans) {
        const value = symbols.origin(span.expression);
        const states = symbols.literalStates(span.expression);
        text +=
          value?.module === "@funwind/db" && value.name.startsWith(TABLE)
            ? value.name === TABLE
              ? " account_deletion_requests "
              : value.name === `${TABLE}.status`
                ? " __deletion_status__ "
                : " __deletion_column__ "
            : states.includes("<动态>")
              ? " __value__ "
              : states.map((state) => `'${state.replaceAll("'", "''")}'`).join(",");
        text += span.literal.text;
      }
    }
  } else if (ts.isCallExpression(node)) {
    const value = symbols.origin(node.expression);
    if (
      value?.module !== "drizzle-orm" ||
      value.name !== "sql.raw" ||
      !node.arguments[0] ||
      !ts.isStringLiteralLike(node.arguments[0])
    )
      return [];
    text = node.arguments[0].text;
  } else return [];
  const tokens = [
    ...text.matchAll(
      /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|`[^`]*`|"[^"]*"|[a-zA-Z_]\w*|!=|<>|<=|>=|[.=(),<>!]/g,
    ),
  ]
    .map((match) => match[0])
    .filter((token) => !token.startsWith("--") && !token.startsWith("/*"))
    .map((token) =>
      token.startsWith("'") ? token : token.replace(/^[`"]|[`"]$/g, "").toLowerCase(),
    );
  // SELECT 建立独立 SQL 作用域，避免两个 EXISTS 中复用同一别名时串表误判。
  interface Scope {
    parent?: Scope;
    aliases: Map<string, boolean>;
  }
  const root: Scope = { aliases: new Map() };
  const scopes: Scope[] = [];
  const stack = [root];
  let current = root;
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === "(") stack.push(current);
    if (tokens[i] === "select") current = { parent: current, aliases: new Map() };
    scopes.push(current);
    if (tokens[i] === ")") current = stack.pop() ?? root;
    if (["from", "join"].includes(tokens[i]) && /^[a-z_]\w*$/.test(tokens[i + 1] ?? "")) {
      const tableName = tokens[i + 1];
      const deletion = tableName === "account_deletion_requests";
      current.aliases.set(tableName, deletion);
      const alias = tokens[i + 2] === "as" ? tokens[i + 3] : tokens[i + 2];
      if (
        alias &&
        ![
          "where",
          "join",
          "on",
          "order",
          "limit",
          "for",
          "left",
          "right",
          "inner",
          ")",
          ",",
        ].includes(alias)
      )
        current.aliases.set(alias, deletion);
    }
  }
  const deletionAlias = (scope: Scope, alias: string): boolean => {
    for (let current: Scope | undefined = scope; current; current = current.parent)
      if (current.aliases.has(alias)) return current.aliases.get(alias) === true;
    return false;
  };
  const predicates: Predicate[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (
      tokens[i] !== "__deletion_status__" &&
      !(
        tokens[i] === "status" &&
        (tokens[i - 1] === "."
          ? deletionAlias(scopes[i], tokens[i - 2])
          : [...scopes[i].aliases.values()].includes(true))
      )
    )
      continue;
    let start = i + 1;
    if (tokens[start] === "not") start += 1;
    const operator = tokens[start];
    let values: string[] = [];
    if (["=", "!=", "<>", "in"].includes(operator)) {
      start += 1;
      if (operator === "in" && tokens[start] === "(") {
        for (let end = start + 1; end < tokens.length && tokens[end] !== ")"; end += 1)
          if (tokens[end] !== ",") values.push(tokens[end]);
      } else values = [tokens[start]];
    } else {
      const leftEdge = tokens[i - 1] === "." ? i - 2 : i;
      if (["=", "!=", "<>"].includes(tokens[leftEdge - 1])) values = [tokens[leftEdge - 2]];
      else continue;
    }
    predicates.push({
      node,
      states: [
        ...new Set(
          values.map((value) =>
            value?.startsWith("'") ? value.slice(1, -1).replaceAll("''", "'") : "<动态>",
          ),
        ),
      ].sort(),
      form: "raw SQL",
      locked: /\bfor\s+update\b/i.test(text) || lockedQuery(node),
    });
  }
  return predicates;
}

/** 静态边界：追踪词法绑定、简单值/表别名与 select 投影；不声称推断任意数据流或非字面量动态 SQL。 */
export function identitySourceProblems(input: Sources, exceptions = IDENTITY_EXCEPTIONS): string[] {
  const symbols = sourceSymbols(input);
  const problems: string[] = [];
  for (const [path, file] of symbols.files) {
    const visit = (node: ts.Node) => {
      const predicates = rawPredicates(node, symbols);
      if (ts.isCallExpression(node)) {
        const callable = symbols.origin(node.expression);
        if (
          callable?.module === "drizzle-orm" &&
          ["eq", "ne", "inArray", "notInArray"].includes(callable.name) &&
          node.arguments.length >= 2
        ) {
          const left = isStatus(node.arguments[0], symbols);
          const right = isStatus(node.arguments[1], symbols);
          if (left || right)
            predicates.push({
              node,
              states: symbols.literalStates(node.arguments[left ? 1 : 0]),
              form: callable.name,
              locked: lockedQuery(node),
            });
        }
      } else if (
        ts.isBinaryExpression(node) &&
        [
          ts.SyntaxKind.EqualsEqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsEqualsToken,
          ts.SyntaxKind.EqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsToken,
        ].includes(node.operatorToken.kind)
      ) {
        const left = isStatus(node.left, symbols);
        const right = isStatus(node.right, symbols);
        if (left || right)
          predicates.push({
            node,
            states: symbols.literalStates(left ? node.right : node.left),
            form: "status 比较",
            locked: lockedQuery(node),
          });
      }
      for (const predicate of predicates) {
        const owner = ownerOf(node);
        const allowed = exceptions.some(
          (entry) =>
            entry.path === path &&
            entry.owner === owner &&
            entry.reason.trim() &&
            (!entry.lock || predicate.locked) &&
            entry.states.some(
              (states) => [...states].sort().join("|") === predicate.states.join("|"),
            ),
        );
        if (!allowed)
          problems.push(
            `${location(node)} [${owner}] ${predicate.form}(${predicate.states.join(",")})：注销谓词应复用 lib/identity-expr.ts；必要状态机/安全例外须逐函数说明`,
          );
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return problems.sort();
}
