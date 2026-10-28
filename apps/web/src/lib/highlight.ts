import { common, createLowlight } from "lowlight";

/**
 * 代码高亮的语言集（M10.8 Step 5）：渲染管线（`highlight-rehype.ts`）与编辑器（代码块语言下拉）共用同一个 lowlight 实例，
 * 所以「编辑区里看到的颜色」与「发布后的颜色」来自同一套语法。
 *
 * 只用 highlight.js 的 `common` 集合（约 37 种主流语言）：体积可控；站长要的是「常见主流语法」，冷门语言不进来。
 * **不做自动探测**：围栏没写语言就是纯文本——自动探测会误着色旧帖里无语言的 `[code]`，也会让同一段代码在不同帖子里颜色不一。
 */
export const lowlight = createLowlight(common);

/** 单段代码的高亮上限（字符数）：超过则按纯文本输出，防止超长代码拖慢渲染 */
export const HIGHLIGHT_MAX_CHARS = 50_000;

/** 一篇内容里累计高亮的字符数上限：超出预算后的代码块按纯文本输出（实测 85 万字符的极端长帖未缓存时约 0.4 秒，预算把最坏情况压在 ~0.1 秒） */
export const HIGHLIGHT_BUDGET_CHARS = 200_000;

/**
 * 编辑器代码块下拉里的语言。`value` 写进围栏（```value），必须是 lowlight 已注册的名字或别名，
 * 且只含 `[\w-]`（净化白名单只放行 `language-[\w-]+`，所以 C++ / C# 用 cpp / csharp）。
 * 作者手写的别名（js、ts、sh、py、html…）渲染侧同样能高亮，只是不在这个下拉里。
 */
export const CODE_LANGUAGES: readonly { value: string; label: string }[] = [
  { value: "bash", label: "Bash" },
  { value: "c", label: "C" },
  { value: "cpp", label: "C++" },
  { value: "csharp", label: "C#" },
  { value: "css", label: "CSS" },
  { value: "diff", label: "Diff" },
  { value: "go", label: "Go" },
  { value: "ini", label: "INI / TOML" },
  { value: "java", label: "Java" },
  { value: "javascript", label: "JavaScript" },
  { value: "json", label: "JSON" },
  { value: "kotlin", label: "Kotlin" },
  { value: "lua", label: "Lua" },
  { value: "makefile", label: "Makefile" },
  { value: "markdown", label: "Markdown" },
  { value: "php", label: "PHP" },
  { value: "python", label: "Python" },
  { value: "ruby", label: "Ruby" },
  { value: "rust", label: "Rust" },
  { value: "scss", label: "SCSS" },
  { value: "shell", label: "Shell 会话" },
  { value: "sql", label: "SQL" },
  { value: "swift", label: "Swift" },
  { value: "typescript", label: "TypeScript" },
  { value: "xml", label: "HTML / XML" },
  { value: "yaml", label: "YAML" },
];
