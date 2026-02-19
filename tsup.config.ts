import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"], // ← ВАЖНО для universal SDK
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
});

