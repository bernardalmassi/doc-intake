import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

// The eval runner's config (npm run eval, see evals/run.mjs), separate from
// vitest.config.mts so the unit and Supabase suites never see a provider
// key. EVAL_MODE picks what evals/eval.eval.ts does: "replay" (default),
// "live" or "write-fixtures".
//
// Only in live mode are ANTHROPIC_API_KEY, OPENAI_API_KEY and
// EXTRACTION_PROVIDER loaded from .env.local, by exact name. In every other
// mode the two keys are set to empty strings in the test worker, so even a
// key exported in the shell can't reach a replay.
//
// "server-only" is aliased to its empty module so the provider modules can
// be loaded for live recording outside a React server bundle.

const LIVE_VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "EXTRACTION_PROVIDER"] as const;

export default defineConfig(({ mode }) => {
  const live = process.env.EVAL_MODE === "live";
  let env: Record<string, string>;
  if (live) {
    const loaded = loadEnv(mode, process.cwd(), [...LIVE_VARS]);
    env = Object.fromEntries(LIVE_VARS.filter((name) => loaded[name]).map((name) => [name, loaded[name]]));
  } else {
    env = { ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" };
  }
  return {
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
        "server-only": fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)),
      },
    },
    test: {
      include: ["evals/**/*.eval.ts"],
      // runExtraction's JSON log lines would bury the report; the eval
      // prints its own
      setupFiles: ["tests/setup/quiet-logs.ts"],
      env,
      reporters: ["verbose"],
      // live calls take seconds each; replay takes milliseconds
      testTimeout: live ? 15 * 60_000 : 60_000,
    },
  };
});
