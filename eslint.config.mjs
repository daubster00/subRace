import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  // Disallow explicit `any`
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  // Block direct process.env access outside env.ts
  {
    files: ["src/**/*.{ts,tsx}", "worker/**/*.ts"],
    ignores: ["src/lib/env.ts", "src/lib/db.ts", "src/proxy.ts"],
    rules: {
      "no-restricted-properties": ["error", {
        object: "process",
        property: "env",
        message: "Use `import { env } from '@/lib/env'` instead of `process.env` directly.",
      }],
    },
  },
]);

export default eslintConfig;
