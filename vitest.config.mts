import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

// Two projects:
//
//   unit      tests/unit: no database, no network, no secrets (what CI runs,
//             `npm run test:unit`). "server-only" is not aliased, so a unit
//             test that imports a server-only module fails to load.
//   supabase  tests/*.test.ts, against the TEST project in .env.test. Users
//             sign in with the publishable key. The local worker runner
//             (tests/helpers/local-worker.ts) is the only code that uses the
//             test project's secret key: it is mapped here to the names the
//             worker reads, SUPABASE_SECRET_KEY and NEXT_PUBLIC_SUPABASE_URL,
//             and "server-only" is aliased to its empty module so
//             src/lib/extraction/worker.ts can load, as in the eval config.
//
// Only SUPABASE_TEST_* vars are read, from .env.test / .env.test.local or
// the environment, so tests can't silently pick up the app's .env.local.
// The provider keys are blanked in both, so a key exported in the shell
// can't reach a test either.
export default defineConfig(({ mode }) => {
  const { SUPABASE_TEST_SECRET_KEY, ...testEnv } = loadEnv(mode, process.cwd(), "SUPABASE_TEST_");
  const noProviders = { ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" };
  return {
    resolve: {
      // the app's "@/..." import alias
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    test: {
      // the logger writes nowhere unless a test captures it
      setupFiles: ["tests/setup/quiet-logs.ts"],
      projects: [
        {
          extends: true,
          test: {
            name: "unit",
            include: ["tests/unit/**/*.test.ts"],
            env: { ...testEnv, ...noProviders },
          },
        },
        {
          extends: true,
          resolve: {
            alias: {
              "server-only": fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)),
            },
          },
          test: {
            name: "supabase",
            include: ["tests/*.test.ts"],
            env: {
              ...testEnv,
              ...noProviders,
              SUPABASE_TEST_SECRET_KEY: SUPABASE_TEST_SECRET_KEY ?? "",
              SUPABASE_SECRET_KEY: SUPABASE_TEST_SECRET_KEY ?? "",
              NEXT_PUBLIC_SUPABASE_URL: testEnv.SUPABASE_TEST_URL ?? "",
              EXTRACTION_WORKER_SECRET: "",
            },
            // Real network round trips to Supabase.
            testTimeout: 30_000,
            hookTimeout: 60_000,
            // One file at a time: the local runner claims whatever is next
            // in the test project's queue.
            fileParallelism: false,
          },
        },
      ],
    },
  };
});
