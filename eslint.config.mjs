import next from "eslint-config-next/core-web-vitals";
import ts from "eslint-config-next/typescript";

const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      ".data/**",
      "coverage/**",
      "out/**",
      "next-env.d.ts",
      "tsconfig.tsbuildinfo",
    ],
  },
  ...next,
  ...ts,
  {
    rules: {
      // Prototype-to-product codebase: unused vars are errors, underscore-prefixed are intentional.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
];

export default config;
