import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
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
