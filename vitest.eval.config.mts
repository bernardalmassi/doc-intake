import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { defineConfig } from "vitest/config";

// The eval runner's config (npm run eval, see evals/run.mjs), separate from
// vitest.config.mts so the unit and Supabase suites never see a provider
// key. EVAL_MODE picks what evals/eval.eval.ts does: "replay" (default),
// "live" or "write-fixtures".
//
// The test worker gets exactly these three variables, set here whatever
// the shell has:
//   live mode      ANTHROPIC_API_KEY and OPENAI_API_KEY from .env.local and
//                  from nowhere else (not .env, not .env.test, not a shell
//                  export), empty if the file lacks them; EXTRACTION_PROVIDER
//                  from .env.local or the default, "anthropic". It only
//                  decides which provider selectProviders calls primary;
//                  live recording records both.
//   other modes    both keys empty, so a replay can't reach a provider even
//                  if a key is exported in the shell.
//
// "server-only" is aliased to its empty module so the provider modules can
// be loaded for live recording outside a React server bundle.

function liveEnv(): Record<string, string> {
  const path = fileURLToPath(new URL("./.env.local", import.meta.url));
  const file = existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {};
  return {
    ANTHROPIC_API_KEY: file.ANTHROPIC_API_KEY ?? "",
    OPENAI_API_KEY: file.OPENAI_API_KEY ?? "",
    EXTRACTION_PROVIDER: file.EXTRACTION_PROVIDER ?? "anthropic",
  };
}

export default defineConfig(() => {
  const live = process.env.EVAL_MODE === "live";
  const env = live ? liveEnv() : { ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", EXTRACTION_PROVIDER: "anthropic" };
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
