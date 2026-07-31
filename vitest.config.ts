import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Resolve workspace packages to source so tests never require a build.
      "@paid-tw/payment": fileURLToPath(
        new URL("./packages/payment/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/*/src/**/__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: [
        "packages/*/src/**/*.test.ts",
        "packages/*/src/**/__tests__/**",
        // Type-only modules — no executable code.
        "packages/payment/src/provider.ts",
        "packages/payment/src/types.ts",
      ],
      reporter: ["text", "html"],
      thresholds: {
        statements: 70,
        branches: 55,
        functions: 70,
        lines: 70,
      },
    },
  },
});
