import { vi } from "vitest";

/**
 * Every file that calls `Sentry.init`, repo-relative: the server, edge and
 * browser runtimes. One list (INV-SSOT-001) for the suites that check each
 * initialisation — the privacy-options spread and the release tag (#5262).
 * `sentry-release.test.ts` discovers the calls in the tree and fails when this
 * list and the tree disagree, so a fourth runtime cannot be added unchecked.
 */
export const SENTRY_INIT_FILES = [
  "sentry.server.config.ts",
  "sentry.edge.config.ts",
  "src/instrumentation-client.ts",
] as const;

export type SentryInitFile = (typeof SENTRY_INIT_FILES)[number];

/**
 * Runs the browser's initialisation and resolves once `Sentry.init` has been
 * called. The browser initialises only after its runtime DSN arrives (#4982),
 * so the settings fetch is stubbed with a made-up DSN. For a suite that mocks
 * `@sentry/nextjs` and reads the options `init` was handed; the caller resets
 * modules first and unstubs globals afterwards.
 */
export async function loadBrowserSentryInit(): Promise<void> {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ dsn: "https://public@example.ingest.sentry.io/1" })),
    ),
  );
  await import("@/instrumentation-client");
  const { browserSentryReady } = await import("@/lib/observability/browser-sentry-client");
  await browserSentryReady;
}
