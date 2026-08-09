// ESLint flat config — runtime-error guard for the static JS bundle.
//
// Purpose: catch brick-class runtime errors that `node --check`, source-presence
// tests, and even executing the file all MISS, because the error only fires when a
// specific function actually runs in the browser. Canonical case: #3162 — a `const`
// binding reassigned inside `_ensureMessagesLoaded` threw a TypeError that bricked
// "load conversation messages" on every mobile message in v0.51.161-166.
//
// Scope discipline: ONLY rules that flag genuine "throws at runtime" bugs AND have
// ZERO hits on the current clean tree (so the gate is green today and only ever
// fails on a NEW regression). This is NOT a style linter.
//
// Deliberately EXCLUDED (verified to have pre-existing intentional hits 2026-05-30):
//   - no-dupe-keys (92 hits): intentional i18n locale-fallback override pattern
//   - no-func-assign (2 hits): switchPanel/switchSettingsSection override pattern
//   - no-redeclare (1 hit): redeclared loop var in panels.js
// If those are cleaned up later, they can be promoted into this guard.
//
// Bundled assets NOT ignored: the Hyrax 3D ES-module bundle (embodiment-bundle.js)
// uses sourceType: "module" via a narrow override below. Runtime-error rules remain
// active for ALL files — the override only changes the parser mode so valid ESM
// import/export doesn't cause a false-positive parsing error.
//
// Run: npx eslint -c eslint.runtime-guard.config.mjs "static/**/*.js"
// (tests/test_static_js_runtime_lint.py runs this automatically when eslint is present.)

export default [
  // Third-party vendor assets (unminified). Minified assets are also excluded.
  { ignores: ["**/vendor/**", "**/*.min.js"] },
  {
    files: ["**/*.js"],
    languageOptions: { ecmaVersion: "latest", sourceType: "script" },
    rules: {
      // #3162: reassigning a `const` — runtime TypeError, only fires on execution.
      "no-const-assign": "error",
      // Assigning to an import binding — runtime TypeError.
      "no-import-assign": "error",
    },
  },
  // Narrow override: Hyrax 3D ES-module bundle uses ESM syntax (import/export).
  // Only the parser mode changes — runtime-error rules remain fully active.
  // Inline eslint-disable comments from the TypeScript build source reference
  // rules (e.g. @typescript-eslint/naming-convention, compat/compat) that don't
  // exist in this config — noInlineConfig keeps ESLint from tripping on those.
  {
    files: ["static/hyrax/3d/**/*.js"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    linterOptions: { noInlineConfig: true },
    rules: {
      "no-const-assign": "error",
      "no-import-assign": "error",
    },
  },
  // Narrow override: Hyrax shell controller modules (hq.js / vn.js /
  // projects.js — t_b91c5672 migration) are ES modules loaded via dynamic
  // import from bootstrap.js. Only the parser mode changes; runtime-error
  // rules remain fully active.
  {
    files: ["static/hyrax/hq.js", "static/hyrax/vn.js", "static/hyrax/projects.js"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    rules: {
      "no-const-assign": "error",
      "no-import-assign": "error",
    },
  },
];
