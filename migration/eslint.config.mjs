import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", "coverage/**", "reports/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // 旧库行映射天然无类型：只读守卫与 UPSERT 结构已兜底；M5 期收紧
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
