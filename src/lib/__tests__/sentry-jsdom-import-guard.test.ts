// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

/**
 * Sentry must remain importable under jsdom.
 *
 * `@sentry/nextjs` 10.73.0 reached its build-time orchestrion/Webpack helper on
 * import. That helper calls `fileURLToPath()` on a URL derived from
 * `document.baseURI`, and jsdom's baseURI is `http://…`, so merely importing the
 * package threw:
 *
 *     TypeError: The URL must be of scheme file
 *       at fileURLToPath (@apm-js-collab/code-transformer-bundler-plugins)
 *       at @sentry/server-utils/build/cjs/orchestrion/bundler/webpack.js
 *
 * It was a module-evaluation failure, so every jsdom suite whose graph reached
 * Sentry died before a single test ran — and it arrived through a routine minor
 * bump, which is exactly the kind of change nobody re-reads. Upstream fixed it
 * in 10.74.0.
 *
 * This repository is currently on a version that predates the break, which is
 * the right moment to add the guard rather than the wrong one: it costs one
 * import, and it fails loudly on the bump that would otherwise reintroduce it.
 *
 * Deliberately about the IMPORT and nothing else — no knowledge of Sentry's API
 * beyond the entry point the error boundaries actually use.
 *
 * Found and fixed in the Tokoroa deployment fork; see its PR #303.
 */
describe("Sentry import guard", () => {
  it("imports @sentry/nextjs under jsdom without throwing", async () => {
    const sentry = await import("@sentry/nextjs");
    expect(sentry).toBeTruthy();
    expect(typeof sentry.captureException).toBe("function");
  });
});
