import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Integration tests run against the real Supabase Postgres (PRD §21.8),
    // so they are not parallel-safe with each other by default.
    fileParallelism: false,
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    globals: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
      // Next's server-only marker does not resolve outside its bundler.
      "server-only": new URL(
        "./tests/helpers/server-only-stub.ts",
        import.meta.url,
      ).pathname,
    },
  },
});
