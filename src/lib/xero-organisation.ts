/**
 * Reads the connected Xero organisation's accounting financial year-end month.
 *
 * Used as the default for the membership financial year (an admin can override
 * it when the membership subscription year differs from the accounting year).
 * The value changes almost never, so it is cached in-process with a long TTL.
 * Each serverless instance fetches at most once per TTL.
 */

import logger from "@/lib/logger";
import {
  classifyXeroWireTemporal,
  xeroCalendarDateAsDateOnly,
} from "@/lib/xero-provider-dates";
import {
  getXeroErrorHeader,
  getXeroErrorStatusCode,
} from "@/lib/xero-error-shape";
import {
  fetchMockXeroOrganisation,
  getXeroMockInternalOrigin,
} from "@/lib/xero-mock-endpoint";
import { registerXeroOrganisationCacheInvalidator } from "@/lib/xero-organisation-cache-bus";
import { callXeroApi, getAuthenticatedXeroClient } from "./xero-api-client";

/**
 * How long a SUCCESSFUL organisation read is reused in this process.
 *
 * The honest bound on it (#2314 review): invalidation runs over the in-process
 * bus in `xero-organisation-cache-bus.ts`, which reaches only the process that
 * handled the connect/disconnect. In a multi-process deployment a web, cron or
 * worker process that did not can therefore keep the PREVIOUS organisation's
 * summary — its name, its financial year end and its deep-link short code — for
 * up to this TTL after a reconnect to a different Xero organisation.
 *
 * That is accepted for screens: they re-render, so the links correct themselves
 * once the entry expires, and re-reading per render is the cost the shared cache
 * exists to avoid (see `xero-link-short-code.ts`). It is NOT accepted for email,
 * which cannot be re-rendered and whose links actively switch the reader's Xero
 * session — the three alert senders pass `getXeroOrgShortCode({ confirmLive:
 * true })`, which forces the read and names no organisation unless it succeeded.
 */
const ORG_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

interface OrgYearEndCacheEntry {
  month: number | null;
  fetchedAt: number;
}

let cached: OrgYearEndCacheEntry | null = null;

/**
 * The year-end read currently in flight, shared by every caller that arrives
 * while it runs (#2261 review). Same single-flight shape as the summary read
 * below — one mechanism, not two divergent ones.
 */
let yearEndInFlight: Promise<number | null> | null = null;

/**
 * When a non-forced live year-end attempt is allowed again (null = no failure
 * is currently suppressing one).
 *
 * This is attempt control, not a negative value cache: it never invents or
 * pins a month. Inside the window a non-forced caller is handed exactly the
 * value a fresh failing read would have handed it ({@link yearEndFallbackMonth})
 * — it just skips the live Xero call that was about to fail again. See #2283
 * review F1, and {@link yearEndFailureThrottleMs} for how long the window is.
 */
let yearEndSuppressedUntil: number | null = null;

/**
 * The DEFAULT window a failed year-end read suppresses the next live attempt
 * for (#2283 review F1).
 *
 * Deliberately much shorter than the summary read's 60-second negative TTL,
 * because this month is money-adjacent: it feeds membership financial-year
 * resolution, and a connection an admin has just fixed must come back almost
 * at once. Fifteen seconds is enough to stop member-facing traffic turning one
 * broken connection into a live `getOrganisations` call per request — which is
 * what would otherwise pin Xero's per-minute limit and push the instance
 * towards the daily limit — while capping the extra recovery latency at a
 * quarter of a minute. `forceRefresh` (an admin explicitly re-checking) ignores
 * this window entirely.
 */
const YEAR_END_FAILURE_THROTTLE_MS = 15 * 1000; // 15 seconds

/**
 * The window used instead when XERO ITSELF is the problem and we already hold a
 * real month to serve (#2423 review F1).
 *
 * Deliberately mirrors `XERO_TRANSIENT_FAILURE_COOLDOWN_SEC` (120s) in
 * `xero-api-client.ts` — the process-global breaker's own cooldown. It is
 * duplicated rather than imported on purpose: this module stays decoupled from
 * that one's internals (it already name-keys its error classes for the same
 * reason), and every test that mocks `@/lib/xero-api-client` wholesale would
 * otherwise import `undefined` and compute a NaN window.
 *
 * Why it exists. Before #2423 this read ARMED that breaker, which suppressed it
 * — and everything else — for the cooldown. Opting out of arming (rightly:
 * member traffic must not stop invoicing) removed that suppression too, leaving
 * a 15-second throttle as the only bound on a read that makes a live
 * `getOrganisations` call every window for the whole of an outage. So the storm
 * control comes back LOCALLY: when the failure says "Xero is unreachable or
 * refusing", this read backs off for about as long as the breaker would have
 * held it, without touching any other caller.
 *
 * Two deliberate limits on it, both from #2283:
 *
 *   * Only when {@link yearEndFallbackMonth} is non-null, for the first
 *     {@link YEAR_END_COLD_CACHE_FAST_RETRIES} failures. On a COLD cache the
 *     served value is `null`, which `getFinancialYearResolution` turns into the
 *     March default — moving the membership season boundary (and with it the
 *     subscription-enforcement gate). A cold cache therefore keeps re-attempting
 *     at the short window until a real month arrives; backing off for two
 *     minutes is only immediately acceptable when the answer we serve meanwhile
 *     is the real one.
 *   * Only for failures nobody can fix by acting now. A `disconnected` failure
 *     is fixed by an admin reconnecting, and the very next request after they
 *     do must pick it up — so that keeps the 15-second window.
 *
 * `forceRefresh` remains the escape hatch from both windows.
 */
const YEAR_END_OUTAGE_THROTTLE_MS = 120 * 1000; // 2 minutes

/**
 * How many consecutive cold-cache failures keep the SHORT window before an
 * outage-class failure backs off anyway (#2423 review F1, residual).
 *
 * #2283's cold-cache rule is about a BLIP: "a single 429 on a fresh server
 * process" must not leave the March default in place for longer than it takes
 * Xero to answer. It is not a licence to poll Xero every 15 seconds for hours.
 * Unbounded, that is ~4 live `getOrganisations` calls a minute from a process
 * that booted during an outage — enough to walk the shared per-tenant DAILY cap
 * down on its own, and the daily gate is precisely the 24-hour, no-opt-out
 * suppression this review is trying to keep out of reach of member traffic.
 *
 * Eight attempts is about two minutes of fast retries, after which the same
 * outage-class failure takes the long window. What that costs is recovery
 * latency, bounded by the long window: once Xero comes back, this process picks
 * the real month up within ~2 minutes instead of ~15 seconds — and only after
 * two minutes of a genuine outage, during which it was serving the March
 * default either way. A reconnect (which clears every cache here) and
 * `forceRefresh` both reset to attempt one.
 */
const YEAR_END_COLD_CACHE_FAST_RETRIES = 8;

/**
 * Consecutive failed live year-end reads, reset by a success or a reconnect.
 * Only used to bound the cold-cache fast-retry burst above.
 */
let yearEndConsecutiveFailures = 0;

/**
 * How long this failure suppresses the next live attempt.
 *
 * `unavailable` covers a 5xx/408, a refused socket, AND the process-global
 * transient breaker refusing before any HTTP; `rate_limited` covers a live 429
 * and the daily-limit gate refusing pre-HTTP. Both mean "the wait is real and
 * re-asking sooner only spends quota" — exactly what the breaker used to
 * enforce for this read. Everything else (`disconnected`) keeps the short
 * window so an admin's reconnect is picked up at once, as does a cold cache
 * until the failures stop looking like a blip.
 */
function yearEndFailureThrottleMs(
  failureKind: XeroOrganisationReadFailureKind,
  fallbackMonth: number | null,
  consecutiveFailures: number,
): number {
  if (failureKind !== "unavailable" && failureKind !== "rate_limited") {
    return YEAR_END_FAILURE_THROTTLE_MS;
  }
  if (
    fallbackMonth === null &&
    consecutiveFailures <= YEAR_END_COLD_CACHE_FAST_RETRIES
  ) {
    return YEAR_END_FAILURE_THROTTLE_MS;
  }
  return YEAR_END_OUTAGE_THROTTLE_MS;
}

/**
 * The best month available WITHOUT a live Xero call: the last successful
 * year-end read, else the year-end month on the connected-organisation summary
 * (the SAME `getOrganisations` field, read by the summary cache next door),
 * else null.
 *
 * Both sources are cleared by `resetXeroOrganisationCaches` and guarded by the
 * generation counter, so this can never resurrect a previous organisation's
 * month after a reconnect. It exists because the alternative on a cold cache
 * was silently worse: `getFinancialYearResolution` turns a null month into
 * `DEFAULT_FINANCIAL_YEAR_END_MONTH` (March), so a single 429 on a fresh
 * server process could move the membership season boundary for the requests
 * that hit it — including the subscription-enforcement gate — even though the
 * real month was sitting in the summary cache one field away.
 */
function yearEndFallbackMonth(): number | null {
  return cached?.month ?? orgSummaryCache?.summary.financialYearEndMonth ?? null;
}

/**
 * Bumped on every cache reset, and read by ALL THREE organisation reads
 * (year-end month, connected-org summary, lock dates): a read that started
 * before a connect/disconnect invalidation describes the OLD organisation, so
 * it must not write itself into the freshly cleared cache.
 *
 * What the guard does NOT do: it bounds the CACHE, not the value already being
 * returned. A read in flight at the moment of the invalidation still resolves
 * to its own caller with the old organisation's answer — and for the year-end
 * month that caller may be `refreshFinancialYearConfig`, which writes what it
 * was handed into the module global in `financial-year.ts` (no TTL, no
 * generation) where it persists until the next refresh. That residual is
 * bounded and pre-existing; the guard's job is to stop it repeating for the
 * whole of the next TTL.
 */
let orgReadGeneration = 0;

/**
 * One live year-end read. Never throws: a failure degrades to the best month
 * already held (see {@link yearEndFallbackMonth}), or null.
 *
 * Note what this deliberately does NOT do: negative-cache the VALUE, unlike
 * the connected-org summary below. This month feeds membership financial-year
 * resolution, so no failure ever pins a month for a TTL. What a failure does
 * do (#2283 review F1) is set {@link yearEndSuppressedUntil}, which suppresses
 * the next live ATTEMPT for {@link yearEndFailureThrottleMs}; the value served
 * in that window is the same {@link yearEndFallbackMonth} a fresh failing read
 * would return, and `forceRefresh` skips the window outright.
 *
 * What it DOES share with the summary read is the retry posture (#2283,
 * decision item 9 option A, extended by #2423): exactly one attempt, no
 * rate-limit retries, no transient retry, and no arming of the process-global
 * breaker. Failure handling is "degrade now, try again shortly", so waiting
 * inside this call buys nothing — and it competes for the same Xero budget as
 * whatever is failing. Attempt throttling is what replaces the storm control
 * that waiting, and later the breaker this read used to arm, provided as side
 * effects.
 */
async function readXeroFinancialYearEndMonth(): Promise<number | null> {
  const generation = orgReadGeneration;
  try {
    const { xero, tenantId } = await getAuthenticatedXeroClient();
    const response = await callXeroApi(
      () => xero.accountingApi.getOrganisations(tenantId),
      {
        operation: "getOrganisations",
        resourceType: "ORGANISATION",
        workflow: "membershipFinancialYear",
        context: "xero-organisation getFinancialYearEndMonth",
        // Do not wait out a RATE LIMIT (#2283, same rationale as the summary
        // read below): this read degrades to the cached month on failure and
        // re-attempts once the short failure throttle above expires, so
        // retrying inside the call only holds the request open and spends the
        // minute budget the failing sync needs. One attempt, immediate
        // degrade, fresh attempt a few seconds later.
        maxRetries: 0,
        // No transient (5xx/408) retry either — the same pairing the summary
        // read takes below, and for the same reason (#2423 review).
        //
        // #2283 kept the budget at 1 for ONE stated purpose: exhausting it is
        // what arms the breaker, so a budget of 1 meant "it takes two
        // consecutive 5xx to arm". `armTransientBreaker: false` deletes that
        // purpose, and what the second attempt then buys is a second live Xero
        // call on every failed read — during an outage, 2 calls per throttle
        // window against a per-tenant daily cap that invoicing shares — plus,
        // when the 5xx carries `Retry-After`, a sleep of up to `maxWaitSec`
        // INSIDE the member request, with every concurrent caller joined to it
        // by the single flight below. A read that degrades to a good cached
        // month and re-attempts shortly gains nothing from either.
        //
        // `maxTransientRetries: 0` alone would be worse than leaving it at 1
        // (the FIRST 5xx would arm the breaker) — which is why it is only
        // correct alongside the opt-out below. One call, immediate degrade,
        // fresh attempt once the throttle window expires.
        maxTransientRetries: 0,
        // But this read may NEVER ARM the process-global transient breaker
        // (#2423). Exhausting the transient budget otherwise calls
        // `rememberXeroTransientOutage`, which fails EVERY Xero call in this
        // process for two minutes — invoicing, sync and webhook replay
        // included.
        //
        // #2283 kept the arming capability here as a FREQUENCY bound ("it
        // takes two consecutive 5xx"), not as a decision that this read should
        // hold it. The frequency argument does not survive contact with where
        // this read actually sits: unattended member-facing traffic (the
        // subscription gate), so it fires with nobody choosing to trigger it.
        // Failures cache nothing, so while Xero is 5xx-ing only the attempt
        // throttle above bounds it — at the flat 15 seconds it had then, one
        // member request per window kept a 120-second cooldown permanently
        // armed, and queued invoicing turned into FAILED-unattempted rows that
        // nothing auto-recovers. One member page view must not be able to stop
        // the club's invoicing.
        //
        // Nothing is lost in DETECTION: arming stays on by default for every
        // call that matters — invoicing, sync, webhook replay, the lock-date
        // read below — so a genuine Xero outage still trips the breaker, just
        // never from here. And opting out of ARMING is not opting out of
        // RESPECTING it: while a cooldown armed by one of those calls is
        // active, `withXeroRetry` refuses this read before any HTTP and it
        // degrades to {@link yearEndFallbackMonth} exactly as any other
        // failure does.
        //
        // What the opt-out DID cost is storm control: arming was also what
        // suppressed this read during an outage. That is restored locally,
        // without touching any other caller, by
        // {@link YEAR_END_OUTAGE_THROTTLE_MS}.
        armTransientBreaker: false,
      },
    );
    const raw = response.body.organisations?.[0]?.financialYearEndMonth;
    const month =
      typeof raw === "number" && raw >= 1 && raw <= 12 ? raw : null;
    if (generation === orgReadGeneration) {
      cached = { month, fetchedAt: Date.now() };
      // Recovery is immediate: a success clears the throttle, so the next
      // failure starts a fresh window rather than extending an old one — and
      // starts the cold-cache fast-retry budget over.
      yearEndSuppressedUntil = null;
      yearEndConsecutiveFailures = 0;
    }
    return month;
  } catch (error) {
    // The best month we already hold — the last successful year-end read, else
    // the summary cache's copy of the same Xero field. (Both are cleared by an
    // invalidation, so this cannot resurrect the old org's month either.)
    // Without the second hop a cold-cache failure returned null, which
    // `getFinancialYearResolution` turns into the March default. It decides
    // BOTH what this failure serves and how long it suppresses the next
    // attempt, so it is read once, here.
    const fallbackMonth = yearEndFallbackMonth();
    const failureKind = classifyOrganisationReadFailure(error).kind;
    logger.warn(
      { err: error, failureKind, fallbackMonth },
      "Failed to read Xero organisation financial year-end month",
    );
    if (generation === orgReadGeneration) {
      // Guarded like the cache write: a read abandoned by a reconnect must not
      // throttle the FRESH connection's first attempt, nor spend its fast-retry
      // budget.
      yearEndConsecutiveFailures += 1;
      yearEndSuppressedUntil =
        Date.now() +
        yearEndFailureThrottleMs(
          failureKind,
          fallbackMonth,
          yearEndConsecutiveFailures,
        );
    }
    return fallbackMonth;
  }
}

/**
 * Returns the Xero organisation's financial year-end month (1-12), or null if
 * Xero is not connected or the value is unavailable. Cached in-process, and
 * concurrent cold-cache callers share a single underlying read.
 *
 * The single flight matters most while the connection is present but FAILING:
 * nothing is cached then (see above), so without it N concurrent requests meant
 * N live Xero calls in exactly the state where Xero is least able to serve
 * them. The one consequence worth naming is that a joiner now shares the
 * leader's failure instead of making its own attempt that might have succeeded;
 * both outcomes resolve to the same fallback month, and N calls into a failing
 * Xero is the worse of the two.
 *
 * Single flight only bounds callers that overlap IN TIME. Serial traffic — the
 * member-facing subscription gate, one request after another — is bounded
 * instead by the post-failure throttle (see {@link yearEndSuppressedUntil} and
 * {@link yearEndFailureThrottleMs}); `forceRefresh` bypasses both and always
 * goes live.
 */
export async function getXeroFinancialYearEndMonth(
  forceRefresh = false,
): Promise<number | null> {
  if (!forceRefresh) {
    if (cached && Date.now() - cached.fetchedAt < ORG_CACHE_TTL_MS) {
      return cached.month;
    }
    if (yearEndInFlight) return yearEndInFlight;
    if (yearEndSuppressedUntil !== null && Date.now() < yearEndSuppressedUntil) {
      // A live attempt failed recently. Hand back the same value a fresh
      // failing attempt would produce, without making the call — see
      // {@link yearEndFailureThrottleMs}. Nothing is pinned: the very next call
      // after the window (or any forceRefresh) goes live again.
      return yearEndFallbackMonth();
    }
  }

  // `readXeroFinancialYearEndMonth` never rejects, so a joiner can never be
  // handed a rejection; the `finally` still clears the slot defensively so a
  // future failure mode cannot wedge this into "permanently in flight".
  const inFlight: Promise<number | null> =
    readXeroFinancialYearEndMonth().finally(() => {
      if (yearEndInFlight === inFlight) yearEndInFlight = null;
    });
  yearEndInFlight = inFlight;
  return inFlight;
}

// ---------------------------------------------------------------------------
// Connected-organisation summary (#2080): the org NAME (+ year-end month) so the
// setup wizard's step 3 can confirm the operator linked the RIGHT Xero org after
// the OAuth round-trip. Cached in-process with the same long TTL as the
// year-end read; a status/summary read must never mutate the DB.
//
// #2261 adds the org SHORT CODE to the same summary — the only identifier the
// Xero web app accepts in a deep link (the tenant GUID we store is not usable
// in a Xero URL). It rides along on the getOrganisations response this summary
// already fetches, so widening the summary with it costs no extra Xero call —
// but the Xero Sync page is a NEW caller of the summary, so its "Go to Xero"
// button does cost one live read per server process per TTL (the first load
// after a restart, after the TTL expires, or after a connect/disconnect; every
// load after that costs none). That one read backs every consumer of this
// summary: the setup wizard's org confirmation, the Xero Sync page's deep link,
// and the subscription-lockout settings panel, which all read
// `/api/admin/xero/organisation`.
//
// #2261 review (F1/F2) hardened the "one read per TTL" claim for the case that
// actually matters — a connection that is PRESENT but FAILING (revoked refresh
// token awaiting re-entry, an org read 500, a per-minute 429 during a bulk
// sync). Before, a failed read cached nothing, so every admin page load
// re-attempted a live call in exactly the state where admins reload most. Now a
// failure is cached under a short NEGATIVE TTL, concurrent cold-cache callers
// share one in-flight read, and the read itself does not retry.
// ---------------------------------------------------------------------------

/**
 * Why the organisation read failed, in the three shapes an OPERATOR can act on
 * differently (#2394):
 *
 * - `disconnected` — the Xero authorisation is gone or unreadable. Only a
 *   reconnect fixes it; waiting or retrying never will.
 * - `rate_limited` — Xero refused because a limit was hit. Waiting fixes it;
 *   retrying immediately makes it worse.
 * - `unavailable` — Xero (or the hop to it) failed transiently. Trying again
 *   now is the right move.
 *
 * Deliberately coarse. It exists so the setup wizard can tell an operator which
 * of those three things to do — not to describe the error.
 */
export type XeroOrganisationReadFailureKind =
  | "disconnected"
  | "rate_limited"
  | "unavailable";

export interface XeroOrganisationReadFailure {
  kind: XeroOrganisationReadFailureKind;
  /**
   * Which Xero limit was hit when `kind` is `rate_limited`, else null. The two
   * clear on completely different timescales — the per-minute limit in about a
   * minute, the daily cap at midnight UTC (about midday in New Zealand) — so a
   * message that cannot tell them apart cannot tell an operator whether to wait
   * or come back tomorrow.
   */
  rateLimit: "minute" | "day" | null;
  /** Seconds Xero (or our own cooldown) said to wait, when it said. */
  retryAfterSeconds: number | null;
}

export interface XeroConnectedOrganisation {
  name: string | null;
  financialYearEndMonth: number | null;
  /**
   * Xero's organisation short code (e.g. `!aBc12`), or null when unavailable.
   * Callers must treat null as "build the generic go.xero.com link" — never as
   * a reason to hide or disable the link.
   */
  shortCode: string | null;
  /**
   * Why the last read failed, or null when it succeeded (#2394).
   *
   * Every other field on this summary degrades silently on failure — that is
   * the whole point of the fallback below — so before this field existed a
   * caller could not tell "Xero has no name for you" from "we never got to
   * ask". The setup wizard's org-confirmation step sat on
   * "Confirming the organisation name…" forever because of exactly that.
   *
   * Non-wizard callers (the deep-link short code, the year-end month, the
   * lockout panel) can keep ignoring it: they already treat nulls as "degrade
   * to the generic behaviour", which stays correct.
   *
   * Note a failure can arrive ALONGSIDE real values: a failed read falls back
   * to the last known summary, so `name` may be a still-good cached name with
   * `readFailure` set. Prefer the value; the failure is why it is not fresher.
   */
  readFailure: XeroOrganisationReadFailure | null;
}

/** Empty summary: the shape a failed/never-run read degrades to. */
const EMPTY_ORG_SUMMARY: XeroConnectedOrganisation = {
  name: null,
  financialYearEndMonth: null,
  shortCode: null,
  readFailure: null,
};

/** Seconds from a `Retry-After` header value (delta-seconds or HTTP date). */
function parseRetryAfterSeconds(value: string | undefined): number | null {
  if (!value) return null;
  const numeric = Number.parseInt(value, 10);
  if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  const retryAtMs = Date.parse(value);
  if (Number.isFinite(retryAtMs)) {
    return Math.max(0, Math.ceil((retryAtMs - Date.now()) / 1000));
  }
  return null;
}

/** A positive, finite `retryAfterSec` off one of the xero-api-client errors. */
function errorRetryAfterSeconds(error: unknown): number | null {
  const raw = (error as { retryAfterSec?: unknown }).retryAfterSec;
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0
    ? Math.ceil(raw)
    : null;
}

/**
 * Classify an organisation-read failure into the three operator actions.
 *
 * Name-keyed rather than `instanceof`, matching
 * `classifyXeroLockDateCheckFailure` and `getXeroApiErrorInfo`: it keeps this
 * module decoupled from `xero-api-client`'s class identities (which differ
 * across the mock/live paths and under module mocking in tests).
 *
 * Order matters. `XeroDailyLimitError` and `XeroTransientOutageError` are
 * raised by the PROCESS-GLOBAL cooldowns before any HTTP call happens, so they
 * carry no status code — they must be matched by name, and their own
 * `retryAfterSec` is the only "when will this clear" signal available.
 */
function classifyOrganisationReadFailure(
  error: unknown,
): XeroOrganisationReadFailure {
  const name = error instanceof Error ? error.name : "";

  // Only an admin re-authorisation fixes these (revoked refresh token, missing
  // tenant, or a stored token that no longer decrypts after an auth-secret
  // change) — the same two names getXeroApiErrorInfo maps to "reconnect".
  if (name === "XeroReconnectRequiredError" || name === "XeroTokenDecryptError") {
    return { kind: "disconnected", rateLimit: null, retryAfterSeconds: null };
  }

  if (name === "XeroDailyLimitError") {
    return {
      kind: "rate_limited",
      rateLimit: "day",
      retryAfterSeconds: errorRetryAfterSeconds(error),
    };
  }

  // The process-global transient breaker: Xero itself may be fine by now, but
  // this process will refuse for the rest of the cooldown, so the wait is real
  // and worth telling the operator about.
  if (name === "XeroTransientOutageError") {
    return {
      kind: "unavailable",
      rateLimit: null,
      retryAfterSeconds: errorRetryAfterSeconds(error),
    };
  }

  const statusCode = getXeroErrorStatusCode(error);

  if (statusCode === 429) {
    const problem = getXeroErrorHeader(error, "x-rate-limit-problem");
    return {
      kind: "rate_limited",
      rateLimit: problem === "day" || problem === "minute" ? problem : null,
      retryAfterSeconds: parseRetryAfterSeconds(
        getXeroErrorHeader(error, "retry-after"),
      ),
    };
  }

  // A live 401/403 (the token was revoked in Xero's UI before the pre-expiry
  // refresh window noticed) arrives as a raw API error, not a reconnect-classed
  // one — same status fallback as getXeroApiErrorInfo and the lock-date guard.
  if (statusCode === 401 || statusCode === 403) {
    return { kind: "disconnected", rateLimit: null, retryAfterSeconds: null };
  }

  // Everything else — 5xx, 408, a refused socket, a mock-harness loopback
  // failure — is "try again now".
  return { kind: "unavailable", rateLimit: null, retryAfterSeconds: null };
}

/**
 * Normalise Xero's `Organisation.shortCode` to a usable value or null. Same
 * extraction as `findDuplicateContacts` (`xero-duplicate-contacts.ts`), except
 * that this returns null rather than "" so the deep-link builders' falsy check
 * and the API contract agree on one absent value.
 */
function normaliseShortCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * How long a FAILED organisation read is remembered (#2261 review, F1).
 *
 * Short enough that an admin who fixes the connection (re-entering credentials,
 * reconnecting, waiting out a per-minute 429) sees the org come back on the
 * next page load or two, but long enough that a page an admin is reloading
 * while Xero is broken cannot turn into one live Xero call per request.
 */
const ORG_SUMMARY_FAILURE_TTL_MS = 60 * 1000; // 60 seconds

interface OrgSummaryCacheEntry {
  summary: XeroConnectedOrganisation;
  fetchedAt: number;
  /**
   * True when this entry records a FAILED read. Failed entries expire under
   * {@link ORG_SUMMARY_FAILURE_TTL_MS} instead of the 12-hour TTL, and any
   * later successful read replaces them outright — so a negative entry can
   * never pin a stale summary for hours.
   */
  failed: boolean;
}

let orgSummaryCache: OrgSummaryCacheEntry | null = null;

/**
 * The read currently in flight, shared by every caller that arrives while it
 * runs (#2261 review, F2) — same single-flight shape as the token-refresh mutex
 * in `xero-api-client` (`_tokenRefreshPromise`). Without it, N concurrent
 * cold-cache requests make N `getOrganisations` calls; with F1's negative cache
 * the window is bounded, but the two fixes belong together: while Xero is
 * failing the cache is cold most often, which is exactly when a stampede hurts.
 */
let orgSummaryInFlight: Promise<XeroConnectedOrganisation> | null = null;

/** The cached summary if it is still fresh for its kind, otherwise null. */
function freshOrgSummary(): XeroConnectedOrganisation | null {
  if (!orgSummaryCache) return null;
  const ttl = orgSummaryCache.failed
    ? ORG_SUMMARY_FAILURE_TTL_MS
    : ORG_CACHE_TTL_MS;
  return Date.now() - orgSummaryCache.fetchedAt < ttl
    ? orgSummaryCache.summary
    : null;
}

/**
 * One live (or mocked) organisation read. Never throws: both the mock and the
 * live path funnel failures into the same catch, which caches the failure under
 * the short negative TTL and degrades to the last known summary (or nulls).
 */
async function readXeroConnectedOrganisation(): Promise<XeroConnectedOrganisation> {
  const generation = orgReadGeneration;
  const remember = (
    summary: XeroConnectedOrganisation,
    failed: boolean,
  ): XeroConnectedOrganisation => {
    if (generation === orgReadGeneration) {
      orgSummaryCache = { summary, fetchedAt: Date.now(), failed };
    }
    return summary;
  };

  try {
    // Server-side fetch — use the in-container origin (see getXeroMockInternalOrigin).
    const mockOrigin = getXeroMockInternalOrigin();
    if (mockOrigin) {
      const mock = await fetchMockXeroOrganisation(mockOrigin);
      return remember(
        {
          name: mock.name,
          financialYearEndMonth: mock.financialYearEndMonth,
          shortCode: normaliseShortCode(mock.shortCode),
          readFailure: null,
        },
        false,
      );
    }

    const { xero, tenantId } = await getAuthenticatedXeroClient();
    const response = await callXeroApi(
      () => xero.accountingApi.getOrganisations(tenantId),
      {
        operation: "getOrganisations",
        resourceType: "ORGANISATION",
        workflow: "setupWizardOrgConfirmation",
        context: "xero-organisation getConnectedOrganisation",
        // Do not wait out a RATE LIMIT (#2261 review, F1): this read only
        // decorates a page — a slow one is worth less than the admin request it
        // holds open. withXeroRetry would otherwise wait out a per-minute 429 up
        // to three times (capped at 120s each), holding the request open for
        // minutes and competing for the same minute budget as the sync that
        // caused the 429. One attempt, cached failure, try again in a minute.
        maxRetries: 0,
        // EXACTLY ONE live call, and it can never arm the process-global
        // transient breaker (#2394 review, F2). The two options are one
        // decision, taken together:
        //
        //   * `maxTransientRetries: 1` (what #2261 chose) means ONE press of the
        //     wizard's Try again spends TWO Xero calls on a 5xx/408, and
        //     exhausting that budget calls `rememberXeroTransientOutage` — the
        //     PROCESS-GLOBAL breaker that then fails every Xero call for two
        //     minutes, invoicing, sync and webhook replay included. #2394 puts
        //     an operator-facing button in front of this read, rendered
        //     precisely when Xero is 5xx-ing, with copy inviting a press. The
        //     blast radius, not the quota, is the problem.
        //   * `maxTransientRetries: 0` ALONE is worse: with no budget left, the
        //     very first 5xx arms the breaker.
        //
        // So: no transient retry (one press = one call, which is what the
        // operator is told), and an explicit opt-out of arming the breaker. This
        // read still RESPECTS a cooldown armed by a call that matters — it
        // refuses before any HTTP and reports the wait — it just may not start
        // one. A page decoration should never be able to stop invoicing.
        maxTransientRetries: 0,
        armTransientBreaker: false,
      },
    );
    const org = response.body.organisations?.[0];
    const rawMonth = org?.financialYearEndMonth;
    return remember(
      {
        name: org?.name ?? null,
        financialYearEndMonth:
          typeof rawMonth === "number" && rawMonth >= 1 && rawMonth <= 12
            ? rawMonth
            : null,
        shortCode: normaliseShortCode(org?.shortCode),
        readFailure: null,
      },
      false,
    );
  } catch (error) {
    const readFailure = classifyOrganisationReadFailure(error);
    logger.warn(
      { err: error, failureKind: readFailure.kind },
      "Failed to read Xero connected organisation summary",
    );
    // Negative-cache the failure, keeping the last known summary as the served
    // value so a transient blip does not blank a name we already have — but
    // now carrying WHY, so a caller with no name to fall back on can say so
    // instead of waiting forever (#2394).
    return remember(
      { ...(orgSummaryCache?.summary ?? EMPTY_ORG_SUMMARY), readFailure },
      true,
    );
  }
}

/**
 * Returns the connected Xero organisation's name, financial year-end month and
 * deep-link short code, or nulls when Xero is not connected / unavailable.
 * Never throws — a failed read falls back to the last cached summary (or
 * nulls). Cached in-process: 12 hours for a successful read, one minute for a
 * failed one, with concurrent cold-cache callers sharing a single read.
 *
 * The cache entry holds the whole summary object, so widening
 * {@link XeroConnectedOrganisation} needs no cache-shape change and no change
 * to {@link resetXeroOrganisationCaches} (which nulls the entry wholesale,
 * negative entries included) or to the connect/disconnect invalidation bus.
 *
 * `forceRefresh` skips BOTH the cache (positive and negative) and the in-flight
 * join, so it reaches the underlying read every time. That is what makes the
 * setup wizard's **Try again** button real (#2394): within the 60-second
 * negative TTL an ordinary read would hand back the cached failure, and a retry
 * button that re-serves the failure it was pressed to clear teaches the operator
 * the button does nothing. The cost is at most ONE `getOrganisations` call per
 * press (the read takes no transient retry), and the owner's decision on #2394
 * was explicitly a manual retry, not an automatic one, so no extra Xero quota is
 * spent unless somebody asks for it.
 *
 * "At most" is exact, not hedging: while a process-global cooldown armed
 * ELSEWHERE is active — the daily-limit gate or the transient-outage breaker —
 * `withXeroRetry` refuses before any HTTP, so a forced read costs nothing and
 * comes back classified with the remaining wait. Being reported the wait is the
 * useful outcome there, so the button is still worth pressing.
 *
 * Honours the test-only mock-Xero harness (#2080): inert in production.
 */
export async function getXeroConnectedOrganisation(
  forceRefresh = false,
): Promise<XeroConnectedOrganisation> {
  if (!forceRefresh) {
    const fresh = freshOrgSummary();
    if (fresh) return fresh;
    if (orgSummaryInFlight) return orgSummaryInFlight;
  }

  // `readXeroConnectedOrganisation` never rejects, so joining callers can never
  // be handed a rejection; the `finally` still clears the slot defensively so a
  // future failure mode cannot wedge the cache into "permanently in flight".
  const inFlight: Promise<XeroConnectedOrganisation> =
    readXeroConnectedOrganisation().finally(() => {
      if (orgSummaryInFlight === inFlight) orgSummaryInFlight = null;
    });
  orgSummaryInFlight = inFlight;
  return inFlight;
}

// ---------------------------------------------------------------------------
// Xero lock dates (#1695): the accounting period lock date and end-of-year
// lock date. A retroactive booking whose check-in (its Xero invoice issue date)
// falls on or before the effective lock date is rejected at create time, so the
// invoice never has to post into a locked period. Cached with a short TTL — the
// admin can unlock the period in Xero and retry within a few minutes.
// ---------------------------------------------------------------------------

const LOCK_DATES_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface XeroLockDates {
  periodLockDate: Date | null;
  endOfYearLockDate: Date | null;
}

interface OrgLockDatesCacheEntry {
  lockDates: XeroLockDates;
  fetchedAt: number;
}

let lockDatesCache: OrgLockDatesCacheEntry | null = null;

/**
 * A Xero lock date as a date-only `Date` in UTC, or `null` when unset or
 * unreadable.
 *
 * `Organisation.periodLockDate` and `endOfYearLockDate` are CALENDAR DATES — a
 * whole accounting day, never a moment — and the wire shape they arrive in
 * varies, which is why they go through the one Xero temporal boundary
 * (`xero-provider-dates.ts`) rather than through a fourth private parser. That
 * module carries the measured evidence for each shape; this function keeps only
 * what is specific to a lock date: a SET but unreadable value must not silently
 * disable the retroactive-booking guard, so treat-as-unset is logged loudly.
 */
function parseXeroLockDate(value: string | Date | undefined | null): Date | null {
  if (!value) return null;

  const lockDate = xeroCalendarDateAsDateOnly(value);
  if (lockDate) return lockDate;

  // Fails open, so make the format drift loud.
  logger.warn(
    { value, shape: classifyXeroWireTemporal(value) },
    "Unparseable Xero lock date; treating as unset",
  );
  return null;
}

/**
 * Returns the connected Xero organisation's period and end-of-year lock dates
 * as date-only Dates (null when unset). Cached in-process for a few minutes.
 *
 * Unlike getXeroFinancialYearEndMonth, this THROWS on a fetch failure when no
 * fresh cache is available: the retroactive-booking route fails closed rather
 * than silently skipping the lock-date guard.
 *
 * Carries the same reconnect (generation) guard as the two reads above, and it
 * matters most here. A read in flight when an admin reconnects to a DIFFERENT
 * Xero organisation carries the old org's lock dates; caching those would let
 * the fail-closed guard evaluate against the wrong organisation for the whole
 * TTL — returning "not locked" for a retroactive booking whose invoice then
 * posts into a locked period in the org that is actually connected. The guard
 * stops the cache write; the abandoned read is still served to its own single
 * caller (one booking), which is the same bounded residual as above.
 */
export async function getXeroLockDates(
  forceRefresh = false,
): Promise<XeroLockDates> {
  const generation = orgReadGeneration;
  if (
    !forceRefresh &&
    lockDatesCache &&
    Date.now() - lockDatesCache.fetchedAt < LOCK_DATES_CACHE_TTL_MS
  ) {
    return lockDatesCache.lockDates;
  }

  try {
    const { xero, tenantId } = await getAuthenticatedXeroClient();
    const response = await callXeroApi(
      () => xero.accountingApi.getOrganisations(tenantId),
      {
        operation: "getOrganisations",
        resourceType: "ORGANISATION",
        workflow: "retroactiveBookingLockDates",
        context: "xero-organisation getLockDates",
      },
    );
    const org = response.body.organisations?.[0];
    const lockDates: XeroLockDates = {
      periodLockDate: parseXeroLockDate(org?.periodLockDate),
      endOfYearLockDate: parseXeroLockDate(org?.endOfYearLockDate),
    };
    // Only cache these lock dates if they still describe the CONNECTED
    // organisation (see the generation counter above). Serving them to this
    // caller is the bounded residual; pinning them for the TTL is not.
    if (generation === orgReadGeneration) {
      lockDatesCache = { lockDates, fetchedAt: Date.now() };
    }
    return lockDates;
  } catch (error) {
    // Fail closed: a fresh cache satisfies the caller, otherwise re-throw so
    // the route returns a retryable error instead of skipping the guard.
    if (
      lockDatesCache &&
      Date.now() - lockDatesCache.fetchedAt < LOCK_DATES_CACHE_TTL_MS
    ) {
      return lockDatesCache.lockDates;
    }
    logger.warn({ err: error }, "Failed to read Xero organisation lock dates");
    throw error;
  }
}

/**
 * The effective lock date is the later of the two set dates: a booking must
 * clear whichever period is locked further into the future. Null when neither
 * is set.
 */
export function getEffectiveXeroLockDate(lockDates: XeroLockDates): Date | null {
  const { periodLockDate, endOfYearLockDate } = lockDates;
  if (periodLockDate && endOfYearLockDate) {
    return periodLockDate.getTime() >= endOfYearLockDate.getTime()
      ? periodLockDate
      : endOfYearLockDate;
  }
  return periodLockDate ?? endOfYearLockDate ?? null;
}

// test seam
export function resetXeroLockDatesCacheForTests(): void {
  lockDatesCache = null;
}

// ---------------------------------------------------------------------------
// Cache invalidation (#2080 review, CORRECTNESS-F1): every cache above is keyed
// on the CONNECTED Xero organisation. When the connection identity changes —
// a connect/reconnect saves new tokens (possibly a DIFFERENT org) or a
// disconnect drops them — those caches are stale and must be reset, or the
// setup wizard's "is this the right org?" step would confirm the OLD org's name.
// The token store fires this via the dependency-free bus (no import cycle).
// ---------------------------------------------------------------------------

/** Reset every in-process organisation cache (name/FYE, summary, lock dates). */
function resetXeroOrganisationCaches(): void {
  cached = null;
  // The year-end failure throttle is scoped to the connection that failed: a
  // reconnect must go live on the very next call, not wait the window out —
  // and the fresh connection starts with its full fast-retry budget.
  yearEndSuppressedUntil = null;
  yearEndConsecutiveFailures = 0;
  // Nulls positive AND negative summary entries: after a reconnect the next
  // read must go live even if the last attempt failed seconds ago.
  orgSummaryCache = null;
  lockDatesCache = null;
  // Abandon any read already in flight — summary, year-end or lock dates: it
  // describes the old connection, so its CACHE WRITE must not survive. The
  // generation bump is what stops the write; nulling the slots stops a caller
  // arriving after the reconnect from JOINING the old connection's read.
  //
  // What is NOT stopped: the in-flight read still resolves to the caller that
  // started it, with the old organisation's answer. For the year-end month that
  // value can be written on into `financial-year.ts`'s module global (see the
  // generation counter's own comment above); for lock dates it decides one
  // in-progress retroactive booking. Both are single-request and bounded — the
  // reset's guarantee is that nothing stale is REPEATED for a whole TTL.
  orgSummaryInFlight = null;
  yearEndInFlight = null;
  orgReadGeneration += 1;
}

registerXeroOrganisationCacheInvalidator(resetXeroOrganisationCaches);

// test seam
export function resetXeroOrganisationCachesForTests(): void {
  resetXeroOrganisationCaches();
}
