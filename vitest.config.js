import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packageName = "@operatornest/convex-web-push";
const src = (path) => fileURLToPath(new URL(`./src/${path}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: new RegExp(`^${packageName}/test$`), replacement: src("test.ts") },
      { find: new RegExp(`^${packageName}$`), replacement: src("client/index.ts") },
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
        "**/fixtures/**",
        "src/test.ts",
        "src/test-helpers.ts",
        "src/component/convex.config.ts",
        "src/component/crons.ts",
      ],
      thresholds: { statements: 90, branches: 85 },
    },
  },
});
