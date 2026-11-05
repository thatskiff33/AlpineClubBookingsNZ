import type * as Sentry from "@sentry/nextjs";
import { BREACHED_PASSWORD_RANGE_URL } from "@/lib/breached-password-endpoint";
import { escapeRegExp } from "@/lib/escape-regexp";

type SentryInitOptions = NonNullable<Parameters<typeof Sentry.init>[0]>;
type SentryBreadcrumb = Parameters<NonNullable<SentryInitOptions["beforeBreadcrumb"]>>[0];
type SentryStreamedSpan = Parameters<NonNullable<SentryInitOptions["beforeSendSpan"]>>[0];

const DENIED_KEY_PARTS = ["forwarded", "-ip", "remote-", "via", "-user"];

// The breached-password range path (#4610, INV-AUTH-005). Sentry instruments
// native fetch, so its outgoing-request span and fetch breadcrumb would carry
// `https://api.pwnedpasswords.com/range/<prefix>`: five characters of the SHA-1
// of a password someone just chose. Matched without the scheme so `url.full`,
// `http.url`, a span name and free text all hit it.
const RANGE_URL = new URL(BREACHED_PASSWORD_RANGE_URL);
const RANGE_HOST_PATH = `${RANGE_URL.host}${RANGE_URL.pathname}`;
const RANGE_SOURCE = escapeRegExp(RANGE_HOST_PATH);
/** Anything naming the range endpoint. Not global, so `.test` keeps no state. */
const RANGE_PATTERN = new RegExp(RANGE_SOURCE, "i");
const RANGE_WITH_PREFIX = () => new RegExp(`${RANGE_SOURCE}[^\\s"'?#&/]*`, "gi");
const RANGE_FILTERED = `${RANGE_HOST_PATH}[Filtered]`;
/** The service's host on its own, as `url.domain` and `server.address` hold it. */
const RANGE_HOST_PATTERN = new RegExp(`^${escapeRegExp(RANGE_URL.hostname)}$`, "i");
/** A bare path attribute (`url.path`) on a span already known to target the host. */
const RANGE_PATH_WITH_PREFIX = new RegExp(`^${escapeRegExp(RANGE_URL.pathname)}[^?#]*`, "i");
const MAX_SCRUB_DEPTH = 12;

/** `text` with every breached-password range prefix replaced by `[Filtered]`. */
export function scrubBreachedPasswordRange(text: string): string {
  return RANGE_PATTERN.test(text) ? text.replace(RANGE_WITH_PREFIX(), RANGE_FILTERED) : text;
}

function mentionsRange(value: unknown, depth: number): boolean {
  if (typeof value === "string") return RANGE_PATTERN.test(value);
  if (depth >= MAX_SCRUB_DEPTH || value === null || typeof value !== "object") return false;
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.some((child) => mentionsRange(child, depth + 1));
}

/**
 * Scrubs the range prefix from every string in `value`, in place, and returns
 * it. Used on events in `beforeSend`, which may hold the URL in an exception
 * message, `extra` or a breadcrumb added before this filter existed.
 */
export function scrubBreachedPasswordRangeDeep<T>(value: T): T {
  const seen = new WeakSet<object>();
  const walk = (node: unknown, depth: number): unknown => {
    if (typeof node === "string") return scrubBreachedPasswordRange(node);
    if (depth >= MAX_SCRUB_DEPTH || node === null || typeof node !== "object") return node;
    if (seen.has(node)) return node;
    seen.add(node);
    // Arrays and plain objects alike: an array's own keys are its indexes.
    for (const key of Object.keys(node)) {
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      // An accessor is never invoked.
      if (!descriptor || !("value" in descriptor)) continue;
      const scrubbed = walk(descriptor.value, depth + 1);
      // A read-only slot (a frozen node's, or one defined non-writable) keeps
      // its value, since strict mode would throw; an object in it was still
      // walked, and scrubbed in place, above.
      if (scrubbed !== descriptor.value && descriptor.writable) {
        (node as Record<string, unknown>)[key] = scrubbed;
      }
    }
    return node;
  };
  return walk(value, 0) as T;
}

/**
 * `beforeBreadcrumb` filter every init calls first: a breadcrumb naming the
 * range endpoint (the fetch breadcrumb's `data.url`, or anywhere else) is
 * dropped; every other breadcrumb is returned unchanged.
 */
export function dropBreachedPasswordRangeBreadcrumb(
  breadcrumb: SentryBreadcrumb,
): SentryBreadcrumb | null {
  return mentionsRange(breadcrumb, 0) ? null : breadcrumb;
}

/**
 * `beforeSendSpan`: the last stop for every streamed span, including spans
 * another instrumentation (Next.js's own fetch span) started, which
 * `ignoreSpans` may not see at start. A span cannot be dropped here, so its
 * name and attribute strings are scrubbed instead.
 */
export function scrubBreachedPasswordRangeSpan(span: SentryStreamedSpan): SentryStreamedSpan {
  const attributes = span.attributes ?? {};
  const targetsService =
    RANGE_PATTERN.test(span.name) ||
    Object.values(attributes).some(
      (value) =>
        typeof value === "string" && (RANGE_PATTERN.test(value) || RANGE_HOST_PATTERN.test(value)),
    );
  span.name = scrubBreachedPasswordRange(span.name);
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === "string") {
      const scrubbed = scrubBreachedPasswordRange(value);
      span.attributes[key] = targetsService
        ? scrubbed.replace(RANGE_PATH_WITH_PREFIX, `${RANGE_URL.pathname}[Filtered]`)
        : scrubbed;
    } else if (Array.isArray(value)) {
      span.attributes[key] = value.map((item: unknown) =>
        typeof item === "string" ? scrubBreachedPasswordRange(item) : item,
      );
    }
  }
  return span;
}

/** A span name pattern, or attribute patterns that must all match (Sentry `ignoreSpans`). */
type RangeIgnoreSpan = RegExp | { attributes: Record<string, RegExp> };

/** Spans naming the range endpoint are never recorded (`ignoreSpans`). */
export const BREACHED_PASSWORD_RANGE_IGNORE_SPANS: RangeIgnoreSpan[] = [
  // Static-lifecycle fetch span names and Next.js's `fetch GET <url>` span.
  RANGE_PATTERN,
  { attributes: { "url.full": RANGE_PATTERN } },
  { attributes: { "http.url": RANGE_PATTERN } },
  { attributes: { "url.domain": RANGE_HOST_PATTERN } },
  { attributes: { "server.address": RANGE_HOST_PATTERN } },
  { attributes: { "net.peer.name": RANGE_HOST_PATTERN } },
];

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
  // #4610: no span carries the breached-password range prefix. Breadcrumbs and
  // events are filtered by each init's beforeBreadcrumb and beforeSend, which
  // call dropBreachedPasswordRangeBreadcrumb and scrubBreachedPasswordRangeDeep.
  ignoreSpans: BREACHED_PASSWORD_RANGE_IGNORE_SPANS,
  beforeSendSpan: scrubBreachedPasswordRangeSpan,
} satisfies Partial<SentryInitOptions>;
