import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => ({
  test: {
    include: ["tests/**/*.test.ts"],
    // Only SUPABASE_TEST_* vars, from .env.test / .env.test.local, so tests
    // can't silently pick up the app's .env.local.
    env: loadEnv(mode, process.cwd(), "SUPABASE_TEST_"),
    // Real network round trips to Supabase.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
}));
