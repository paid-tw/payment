import { defineConfig } from "tsdown";

export default defineConfig({
  // Two entries: the root, and the raw-PAN adapter on its own subpath so it can
  // be excluded from a build by simply not importing it.
  entry: ["src/index.ts", "src/backauth/index.ts"],
  format: ["esm", "cjs"],
  dts: { sourcemap: false },
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "es2022",
  outExtensions: ({ format }) =>
    format === "es" ? { js: ".js", dts: ".d.ts" } : { js: ".cjs", dts: ".d.cts" },
});
