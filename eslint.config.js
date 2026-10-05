// ESLint: JavaScript's recommended rules (https://eslint.org/docs/latest/rules) are this project's
// coding standard, plus a few that catch real bugs. `npm run lint`; CI fails on any warning.
import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/", "runtime/node_modules/", "graphify-out/", "docs/media/"] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      // Helper code also runs inside pages (Playwright's page.evaluate), so both sets apply.
      globals: { ...globals.node, ...globals.browser },
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      eqeqeq: ["error", "smart"],
      "no-var": "error",
      "prefer-const": "error",
      "no-implicit-globals": "error",
      "no-new-func": "error",
      "no-eval": "error",
      "no-implied-eval": "error",
      // `catch {}` is how this code says "best effort, never block the session".
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Masking and input checks match control characters on purpose.
      "no-control-regex": "off",
      // Rethrown errors carry their message in a user-facing sentence, not a cause chain.
      "preserve-caught-error": "off",
      "no-unused-vars": ["error", { args: "after-used", ignoreRestSiblings: true, caughtErrors: "none", varsIgnorePattern: "^_", argsIgnorePattern: "^_" }],
    },
  },
  // The extension and live view pages use Chrome's extension API.
  { files: ["scripts/browser/**"], languageOptions: { globals: { chrome: "readonly" } } },
  // macOS JavaScript for Automation (osascript -l JavaScript).
  // osascript calls its top-level run(); helpers live beside it.
  { files: ["scripts/dock/*-mac.js"], languageOptions: { sourceType: "script", globals: { ObjC: "readonly", Application: "readonly", $: "readonly", Path: "readonly", delay: "readonly" } }, rules: { "no-implicit-globals": "off" } },
  // Tests load the page and extension scripts the way a browser would.
  { files: ["test/**"], rules: { "no-new-func": "off" } },
];
