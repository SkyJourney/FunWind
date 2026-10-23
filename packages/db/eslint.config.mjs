import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", "drizzle/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // 迁移/种子脚本大量使用 `await` 于顶层与 any 行映射：地基期放开，M5 权限内核期收紧
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
