import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Integration tests run against the real Supabase Postgres (PRD §21.8),
    // so they are not parallel-safe with each other by default.
    fileParallelism: false,
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    globals: false,
    /*
     * 90s, from measurement rather than taste.
     *
     * The integration tests build their fixtures through the real
     * repositories, which is what makes them worth running: a test that
     * inserts rows directly proves the schema accepts them and nothing about
     * whether the application does. The cost is round trips, and this
     * database is 130ms away, so a test that seeds a client, an engagement, a
     * case, two entities, a source, a statement, then merges and reverses it
     * spends most of its time waiting on the network. The heaviest one
     * measured 28.9s against the old 30s ceiling: it passed alone with one
     * second to spare and failed whenever anything else was competing for the
     * link, which read as three unrelated flaky tests rather than as one
     * budget set too tight.
     *
     * The average integration test here is around 11s, so this is roughly
     * three times the worst case, which is enough to absorb a slow link
     * without hiding a genuine hang. The pure domain tests run in
     * milliseconds and are unaffected: they fail, they do not hang.
     */
    testTimeout: 90_000,
    hookTimeout: 90_000,
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
