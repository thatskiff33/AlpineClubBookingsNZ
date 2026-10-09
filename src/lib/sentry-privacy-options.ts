import type * as Sentry from "@sentry/nextjs";

type SentryInitOptions = NonNullable<Parameters<typeof Sentry.init>[0]>;

const DENIED_KEY_PARTS = ["forwarded", "-ip", "remote-", "via", "-user"];

/**
 * The privacy half of every `Sentry.init` (server, edge and browser), defined
 * once so the three cannot drift (INV-INT-005, INV-PRIV-011).
 *
 * Sentry 11 replaced `sendDefaultPii` with `dataCollection`, and LEAVING IT
 * UNSET NOW COLLECTS MORE than v10 did: the client IP on events, cookies,
 * unscrubbed headers, and whole request and response bodies on spans. Spans
 * never pass through `beforeSend`, so the app's redactor would not see a login
 * body there (#3892 review). This is Sentry's documented v10 baseline
 * (MIGRATION.md, "If you want to keep the v10 default behavior"), with the
 * stack-trace default v10 had.
 */
export const SENTRY_PRIVACY_INIT_OPTIONS = {
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpHeaders: {
      request: { deny: DENIED_KEY_PARTS },
      response: { deny: DENIED_KEY_PARTS },
    },
    httpBodies: [],
    urlQueryParams: { deny: DENIED_KEY_PARTS },
    genAI: { inputs: false, outputs: false },
    databaseQueryData: false,
    queues: false,
    graphQL: { document: false, variables: false },
  },
  // v11 turned this on by default; captureMessage call sites would gain
  // synthetic stack traces and new issue groups.
  attachStacktrace: false,
} satisfies Partial<SentryInitOptions>;
