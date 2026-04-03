import { defineConfig } from "tsup";

declare const process: any;

export default defineConfig({
  entry: ["src/index.ts"],

  format: ["esm", "cjs"],

  outExtension({ format }) {
    return {
      js: format === "esm" ? ".mjs" : ".cjs",
    };
  },

  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",

  define: {
    __SDK_VERSION__: JSON.stringify(process.env.npm_package_version),
    __EVENTRA_ENDPOINT__: JSON.stringify(process.env.EVENTRA_ENDPOINT),
  },
});
