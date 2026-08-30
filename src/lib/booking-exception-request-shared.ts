/**
 * The browser-safe half of the booking policy-exception request vocabulary
 * (#2851).
 *
 * THIS MODULE IMPORTS NOTHING, AND THAT IS ITS ENTIRE POINT. It is not a
 * convenience grab-bag: it exists so that the two values a `"use client"`
 * component genuinely needs — the member-message cap and the queue's request-age
 * label — can be reached from the browser WITHOUT dragging
 * `@/lib/booking-exception-requests` onto the client graph, and with it
 * `import { createHash } from "node:crypto"`.
 *
 * That was a real, live edge until #2851. Seven `"use client"` modules reached
 * `booking-exception-requests.ts` — two importing it directly and five
 * through those two — and between them they wanted exactly these two runtime
 * symbols. Everything else that module exports is server-side, so the whole
 * workflow module, and its Node-only crypto import, was compiled into the
 * browser bundle for the sake of a number and a string formatter. It built
 * only because the bundler was shimming or dropping `node:crypto`, which is an
 * implementation detail and not a guarantee.
 * `src/lib/__tests__/client-server-boundary-census.test.ts` carried it as its
 * single named exception; #2850 forbids baselining it, so it was removed rather
 * than renewed.
 *
 * **The admission rule for this file: nothing lands here that needs an import.**
 * A helper that needs `@/lib/club-time`, a type from the workflow module, or
 * anything else at runtime belongs in the module that owns it, and the client
 * either does without it or gets it from the server. The moment this file
 * imports something, its guarantee becomes "whatever that thing imports", which
 * is exactly how the original edge appeared.
 *
 * Server code imports from here too — `normalizeMemberMessage` in
 * `booking-exception-requests.ts` validates against the same constant — because
 * a cap the textarea enforces and a cap the server enforces must be one fact,
 * not two (`INV-SSOT`). There is no re-export from the workflow module: a second
 * spelling of the same import is how a client finds its way back onto the server
 * graph.
 */

// ---------------------------------------------------------------------------
// Request age (officer queue)
// ---------------------------------------------------------------------------

/**
 * How long a request has been waiting, in plain English (#2526 acceptance:
 * "queue shows request age").
 *
 * Age, not a timestamp, because the decision the officer is making is partly
 * "how long has this member been waiting?" — a date makes them do the
 * subtraction. Pure and clock-injected so it is unit-testable and renders
 * identically on the server and the client.
 */
export function formatPolicyExceptionRequestAge(
  createdAt: Date,
  now: Date = new Date(),
): string {
  const minutes = Math.floor((now.getTime() - createdAt.getTime()) / 60_000);
  // A clock skew (or a row created a moment ago) reads as "just now" rather
  // than a negative age.
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return days === 1 ? "1 day ago" : `${days} days ago`;
  const weeks = Math.floor(days / 7);
  return weeks === 1 ? "1 week ago" : `${weeks} weeks ago`;
}

// ---------------------------------------------------------------------------
// Member message
// ---------------------------------------------------------------------------

/**
 * The cap on the member's message to the Booking Officers, in characters.
 *
 * One fact, two enforcers: the compose textarea uses it for `maxLength` and for
 * the "N of 1000 characters used" counter, and `normalizeMemberMessage` refuses
 * anything longer at the request boundary. The server one is the authority —
 * `maxLength` on an input is a courtesy a crafted request ignores — and this
 * constant is what keeps the courtesy honest about where the real limit is.
 */
export const MEMBER_MESSAGE_MAX_LENGTH = 1000;
