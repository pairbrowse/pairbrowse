// ESLint: JavaScript's recommended rules (https://eslint.org/docs/latest/rules) are this project's
// coding standard, plus a few that catch real bugs. `npm run lint`; CI fails on any warning.
import js from "@eslint/js";
import globals from "globals";
import { HUD_PARTS, hudPart, hudSource } from "./scripts/hud/assemble.mjs";

// The page script's parts (scripts/hud/*.js) are lines of one function: each is linted as the
// joined script, and keeps only what falls on its own lines, at their numbers in the part.
const lines = (part) => hudPart(part).split("\n").length - 1;
const partOf = (filename) => filename.split(/[\\/]/).pop();
const hudParts = {
  // A file there that isn't a listed part is linted on its own.
  preprocess(text, filename) {
    return [{ text: HUD_PARTS.includes(partOf(filename)) ? hudSource() : text, filename: "hud.js" }];
  },
  postprocess([messages], filename) {
    const part = partOf(filename);
    if (!HUD_PARTS.includes(part)) return messages;
    let first = 1;
    for (const p of HUD_PARTS) {
      if (p === part) break;
      first += lines(p);
    }
    const last = first + lines(part) - 1;
    return messages.filter((m) => !m.line || (m.line >= first && m.line <= last))
      .map(({ fix: _fix, suggestions: _s, ...m }) => ({ ...m, ...(m.line && { line: m.line - first + 1 }), ...(m.endLine && { endLine: m.endLine - first + 1 }) }));
  },
};

export default [
  { ignores: ["node_modules/", "runtime/node_modules/", "graphify-out/", "docs/media/", ".claude/"] },
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
  { files: ["scripts/hud/*.js"], processor: hudParts },
  // The extension's pages (ui/) use Chrome's extension API.
  { files: ["ui/**"], languageOptions: { globals: { chrome: "readonly" } } },
  // macOS JavaScript for Automation (osascript -l JavaScript).
  // osascript calls its top-level run(); helpers live beside it.
  { files: ["scripts/dock/*-mac.js"], languageOptions: { sourceType: "script", globals: { ObjC: "readonly", Application: "readonly", $: "readonly", Path: "readonly", delay: "readonly" } }, rules: { "no-implicit-globals": "off" } },
  // Tests load the page and extension scripts the way a browser would.
  { files: ["test/**"], rules: { "no-new-func": "off" } },
];
