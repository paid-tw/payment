import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: { sourcemap: false },
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "es2022",
  outExtensions: ({ format }) =>
    format === "es" ? { js: ".js", dts: ".d.ts" } : { js: ".cjs", dts: ".d.cts" },
});
