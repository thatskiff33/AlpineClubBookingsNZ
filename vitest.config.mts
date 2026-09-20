// `.mts`, not `.ts`, and that extension is load-bearing (#2864). Vite 8.2.1
// warns that a `.ts` config using ESM syntax is being loaded as CommonJS, and
// when vite makes `configLoader: "native"` the default such a file stops
// loading altogether. `.mts` is unambiguously ESM, so the native loader reads
// it directly. The alternative — `"type": "module"` in `package.json` —
// reinterprets every `.js` file in the repository and was rejected for that
// blast radius.
import path from "node:path";

import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Provide fake email-delivery env so the delivery-config gate is satisfied
    // in tests (nodemailer is mocked, so nothing is actually sent).
    // ORDER MATTERS. vitest.clock-setup.ts freezes "today" (#2481) and must be
    // first: setup files are evaluated in order, and a module's imports are
    // evaluated before its own body, so anything the second setup file imports
    // would otherwise capture the real clock at import time.
    // The async-local-storage global sits between them: Next captures it at
    // MODULE EVALUATION, so it must be set before vitest.setup.ts imports
    // anything that reaches Next. See that file for why it is not a one-liner.
    setupFiles: [
      "./vitest.clock-setup.ts",
      "./vitest.async-local-storage-setup.ts",
      "./vitest.setup.ts",
    ],
    // Never descend into agent git worktrees (.claude/worktrees/*): they hold
    // stale snapshots of the repo whose test files would otherwise be collected
    // and run against the main source via the "@" alias. e2e/ holds Playwright
    // specs that Vitest's default include pattern would otherwise collect.
    exclude: [...configDefaults.exclude, "**/.claude/**", "e2e/**"],
    sequence: {
      // Load-bearing for the frozen test clock (#2481), not a style preference.
      // "list" evaluates setupFiles in the order listed above. Vitest's own
      // config type documents the DEFAULT as "parallel" (Promise.all), which
      // would let vitest.setup.ts — and everything it imports — evaluate before
      // the freeze is installed. It happens to run sequentially today only
      // because resolveConfig never applies that documented default; pinning it
      // is what actually makes the ordering above a contract.
      setupFiles: "list",
      // "stack" runs `beforeAll`/`beforeEach` in definition order, so the setup
      // file's freeze installs FIRST and any suite that pins its own instant
      // with `vi.setSystemTime` in its own hook still wins. `after*` hooks run
      // in reverse, so the setup file hands the clock back last. This is
      // currently Vitest's resolved default; pinned here so a future default
      // change cannot silently invert the override order.
      hooks: "stack",
    },
  },
  resolve: {
    alias: {
      // `import.meta.dirname`, not `__dirname`: this file is now ESM, where
      // the CommonJS wrapper variables do not exist. Reading it under vite's
      // native config loader would otherwise be a ReferenceError (#2864).
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
});
