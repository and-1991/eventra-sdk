// @ts-check
import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// The recommended rules without type information: what the monorepo's `pnpm lint` checks for this package.
export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "reports/**", ".stryker-tmp/**", "tests/fixtures/**", "**/*.d.ts"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // a parameter or binding named with a leading underscore is unused on purpose
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
    },
  },
);
