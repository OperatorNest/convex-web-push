import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (path) => fileURLToPath(new URL(`./src/${path}`, import.meta.url));

export default defineConfig({
  resolve: {
    // Example and client tests run the package from source, so coverage counts src/client.
    alias: [
      { find: /^@operatornest\/convex-web-push\/test$/, replacement: src("test.ts") },
      { find: /^@operatornest\/convex-web-push$/, replacement: src("client/index.ts") },
    ],
  },
  test: {
    environment: "edge-runtime",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "**/_generated/**",
        "**/*.test.ts",
        "**/*.d.ts",
        "src/test.ts",
        "src/test-helpers.ts",
      ],
      thresholds: { statements: 90, branches: 85 },
    },
  },
});
