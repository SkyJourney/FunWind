import coreWebVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// eslint-config-next 16 原生导出 flat config 数组（无需 FlatCompat）
const config = [
  {
    ignores: [
      ".next/**",
      ".next-verify/**",
      ".next-e2e/**",
      ".next-e2e-prod/**",
      ".next-e2e-step7-*/**",
      ".next-e2e-install-prod/**",
      ".next-review-layout/**",
      ".next-e2e-visual/**",
      ".next-lighthouse/**",
      ".next-review-*/**",
      "coverage/**",
      "node_modules/**",
      "next-env.d.ts",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  ...coreWebVitals,
  ...nextTs,
  {
    rules: {
      // M1 基线：允许后续逐步收紧
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
];

export default config;
