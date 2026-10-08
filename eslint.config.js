import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "node_modules/",
      "public/",
      "doctrine/",
      "doctrine-private/",
      "generated-scenes/",
      ".devenv/",
      // Pinned upstream bundle, verified by digest (scripts/verify-versioning-bundle.mjs).
      "vendor/",
    ],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      // Best-effort parsing and cleanup paths deliberately swallow errors.
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
];
