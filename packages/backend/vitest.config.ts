import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    // The FIRST t.fetch in a file loads http.ts → @convex-dev/polar (the polyfill
    // resolution below), which is slow. Under the full parallel suite that one-time
    // cost is load-sensitive and can exceed vitest's default 5s per-test timeout even
    // though the test itself is fast (each such file also warms it in a beforeAll).
    // A generous ceiling absorbs the warm-up without masking a real hang. Phase 6's
    // cascade tests (deleteUserAccount → scheduled purge fan-out) are scheduled-function
    // heavy and, under the full parallel suite's CPU contention, run ~10x slower than in
    // isolation — 30s clears them while a genuine hang still fails.
    testTimeout: 30_000,
    server: {
      deps: {
        // convex-test must be inlined so it shares the same module instances.
        //
        // @convex-dev/polar is inlined because its ESM build imports
        // "./polyfill" without a file extension. Node's ESM resolver rejects
        // that; Vite resolves it. Without this, any test that loads http.ts
        // (which imports ./subscriptions -> polar) dies at import time — which
        // is every test that exercises an HTTP route via t.fetch().
        inline: ["convex-test", "@convex-dev/polar"],
      },
    },
    include: ["convex/**/*.test.ts"],
  },
});
