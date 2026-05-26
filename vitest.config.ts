import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "html"],
    },
  },
  define: {
    __SDK_VERSION__: JSON.stringify("test"),
    __EVENTRA_ENDPOINT__: JSON.stringify("https://test.local/ingest"),
  },
});
