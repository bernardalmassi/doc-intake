import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // One logger. Server code in src/lib logs only through src/lib/log.ts,
  // the single place that decides what may reach a log line (no keys,
  // tokens, URLs or extracted values; see the comment at its top). Not yet
  // applied to src/app, which is being redesigned in parallel.
  {
    files: ["src/lib/**/*.{js,mjs,ts,tsx}"],
    ignores: ["src/lib/log.ts"],
    rules: {
      "no-console": "error",
      "no-restricted-properties": [
        "error",
        { object: "process", property: "stdout", message: "Log through src/lib/log.ts." },
        { object: "process", property: "stderr", message: "Log through src/lib/log.ts." },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
