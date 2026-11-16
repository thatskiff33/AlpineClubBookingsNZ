/**
 * Where the CI-only JSON reporter writes and summarise-playwright-flaky.mjs
 * reads (#4991). It is defined once: playwright.config.ts imports it, and the
 * workflow steps pass no path, so the writer and its readers cannot name
 * different files.
 *
 * This module stays free of `import.meta` and of CLI code: Playwright loads
 * playwright.config.ts and everything it imports through its CommonJS
 * transform, which rewrites `import` to `require` but leaves `import.meta`,
 * a SyntaxError outside an ES module. playwright-config-loading.test.ts pins it.
 */
export const PLAYWRIGHT_RESULTS_FILE = ".artifacts/playwright-results.json";
