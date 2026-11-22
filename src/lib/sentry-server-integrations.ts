import * as Sentry from "@sentry/nextjs";
import { isBreachedPasswordRangeUrl } from "@/lib/breached-password-endpoint";

type SentryIntegration = ReturnType<typeof Sentry.getDefaultIntegrations>[number];

/**
 * Sentry's name for the default integration that opens one session for the
 * server process (@sentry/node). Nothing discards that session once request
 * sessions are off, so it would be sent with the first captured error.
 */
const PROCESS_SESSION_INTEGRATION = "ProcessSession";

/**
 * The integrations `sentry.server.config.ts` hands `Sentry.init`: Sentry's
 * server defaults, changed in three places. The one list the server init and
 * `sentry-server-session-canary.test.ts` both use.
 *
 * Tagging only (#5262): events carry the release, and the server sends no
 * session data. With a release set, the SDK's defaults would send it from two
 * places, so both are switched off here:
 *
 * - the default `Http` integration counts every incoming request as a session
 *   and sends per-minute counts by outcome. `sessions: false` stops that;
 * - the default `ProcessSession` integration is dropped by name.
 *
 * An instance with a default's name replaces that default (core's
 * `filterDuplicates`), so each of these is the only one of its kind installed.
 * `Http` therefore repeats the one option `@sentry/nextjs` builds its own
 * default with, `disableIncomingRequestSpans: true`: Next creates the spans
 * for incoming requests itself. Re-read the SDK's server `init` when upgrading.
 */
export function buildServerSentryIntegrations(defaults: SentryIntegration[]): SentryIntegration[] {
  return [
    ...defaults.filter((integration) => integration.name !== PROCESS_SESSION_INTEGRATION),
    // #4610: the breached-password range request gets no span, no breadcrumb
    // and no `sentry-trace`/`baggage` headers.
    Sentry.nativeNodeFetchIntegration({ ignoreOutgoingRequests: isBreachedPasswordRangeUrl }),
    Sentry.httpIntegration({ disableIncomingRequestSpans: true, sessions: false }),
  ];
}
