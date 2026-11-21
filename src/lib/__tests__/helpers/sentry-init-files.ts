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
