/* ESLint config for the RITHM web app (flat-config-free; ESLint 8 + eslintrc). */
module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    ecmaFeatures: { jsx: true },
  },
  plugins: ["@typescript-eslint", "react-hooks", "jsx-a11y"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:react-hooks/recommended",
    "plugin:jsx-a11y/recommended",
  ],
  ignorePatterns: ["dist", "node_modules"],
  rules: {
    /*
      The Anam SDK may only be reached DYNAMICALLY, and only from one file.

      A static import anywhere reachable from `AvatarPanel` walks the SDK into
      AvatarPanel's chunk, which every desktop Home load pays for — undoing the
      whole point, which is that someone who never presses Talk never downloads
      it. The comment in `lib/anam/session.ts` says so; this is the part that
      is actually enforced, because a comment is not a guard.

      `no-restricted-imports` does not see `import()` expressions, so the rule
      catches exactly the mistake it is meant to and leaves the one legitimate
      call site alone.
    */
    "no-restricted-imports": [
      "error",
      {
        paths: [
          {
            name: "@anam-ai/js-sdk",
            message:
              "Import it dynamically from src/lib/anam/session.ts only — a static " +
              "import walks the SDK into AvatarPanel's chunk, which every desktop " +
              "Home load pays for.",
          },
        ],
      },
    ],
  },
  overrides: [
    {
      // The one file allowed to name the package at all.
      files: ["src/lib/anam/session.ts"],
      rules: { "no-restricted-imports": "off" },
    },
  ],
};
