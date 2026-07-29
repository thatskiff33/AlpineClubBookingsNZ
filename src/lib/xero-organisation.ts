/**
 * Reads the connected Xero organisation's accounting financial year-end month.
 *
 * Used as the default for the membership financial year (an admin can override
 * it when the membership subscription year differs from the accounting year).
 * The value changes almost never, so it is cached in-process with a long TTL.
 * Each serverless instance fetches at most once per TTL.
 */

import logger from "@/lib/logger";
import { parseDateOnly } from "@/lib/date-only";
import {
  fetchMockXeroOrganisation,
  getXeroMockInternalOrigin,
} from "@/lib/xero-mock-endpoint";
import { registerXeroOrganisationCacheInvalidator } from "@/lib/xero-organisation-cache-bus";
import { callXeroApi, getAuthenticatedXeroClient } from "./xero-api-client";

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
 * When the last year-end read FAILED (null = the last read succeeded, or none
 * has run since the caches were reset).
 *
 * This is attempt control, not a negative value cache: it never invents or
 * pins a month. Within {@link YEAR_END_FAILURE_THROTTLE_MS} of a failure a
 * non-forced caller is handed exactly the value a fresh failing read would
 * have handed it ({@link yearEndFallbackMonth}) — it just skips the live Xero
 * call that was about to fail again. See #2283 review F1.
 */
let yearEndFailedAt: number | null = null;

/**
 * How long a FAILED year-end read suppresses the next live attempt (#2283
 * review F1).
 *
 * Deliberately much shorter than the summary read's 60-second negative TTL,
 * because this month is money-adjacent: it feeds membership financial-year
 * resolution, and a connection an admin has just fixed must come back almost
 * at once. Fifteen seconds is enough to stop member-facing traffic turning one
 * broken connection into a live `getOrganisations` call per request — which is
 * what would otherwise pin Xero's per-minute limit and push the instance
 * towards the daily limit and the process-global breaker — while capping the
 * extra recovery latency at a quarter of a minute. `forceRefresh` (an admin
 * explicitly re-checking) ignores this window entirely.
 */
const YEAR_END_FAILURE_THROTTLE_MS = 15 * 1000; // 15 seconds

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
 * do (#2283 review F1) is record {@link yearEndFailedAt}, which suppresses the
 * next live ATTEMPT for {@link YEAR_END_FAILURE_THROTTLE_MS}; the value served
 * in that window is the same {@link yearEndFallbackMonth} a fresh failing read
 * would return, and `forceRefresh` skips the window outright.
 *
 * What it DOES share with the summary read is the retry posture (#2283,
 * decision item 9 option A): one attempt, no rate-limit retries, transient
 * budget intact. Failure handling is "degrade now, try again shortly", so
 * waiting out a 429 for minutes inside this call buys nothing — and it
 * competes for the same per-minute Xero budget as whatever caused the 429.
 * The throttle above is what replaces the storm control that waiting used to
 * provide as a side effect.
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
        // But KEEP the transient (5xx/408) budget at withXeroRetry's default
        // of 1 — `maxRetries: 0` alone would zero it via the
        // `min(maxRetries, 1)` default, and exhausting the transient budget
        // arms `rememberXeroTransientOutage`, the PROCESS-GLOBAL breaker that
        // fails every Xero call (invoicing and sync included) for two
        // minutes. This read must not be able to trip that on its own first
        // 5xx. See the summary read below for the full account.
        maxTransientRetries: 1,
      },
    );
    const raw = response.body.organisations?.[0]?.financialYearEndMonth;
    const month =
      typeof raw === "number" && raw >= 1 && raw <= 12 ? raw : null;
    if (generation === orgReadGeneration) {
      cached = { month, fetchedAt: Date.now() };
      // Recovery is immediate: a success clears the throttle, so the next
      // failure starts a fresh window rather than extending an old one.
      yearEndFailedAt = null;
    }
    return month;
  } catch (error) {
    logger.warn(
      { err: error },
      "Failed to read Xero organisation financial year-end month",
    );
    if (generation === orgReadGeneration) {
      // Guarded like the cache write: a read abandoned by a reconnect must not
      // throttle the FRESH connection's first attempt.
      yearEndFailedAt = Date.now();
    }
    // Fall back to the best month we already hold — the last successful
    // year-end read, else the summary cache's copy of the same Xero field.
    // (Both are cleared by an invalidation, so this cannot resurrect the old
    // org's month either.) Without the second hop a cold-cache failure
    // returned null, which `getFinancialYearResolution` turns into the March
    // default.
    return yearEndFallbackMonth();
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
 * instead by the short post-failure throttle (see {@link yearEndFailedAt});
 * `forceRefresh` bypasses both and always goes live.
 */
export async function getXeroFinancialYearEndMonth(
  forceRefresh = false,
): Promise<number | null> {
  if (!forceRefresh) {
    if (cached && Date.now() - cached.fetchedAt < ORG_CACHE_TTL_MS) {
      return cached.month;
    }
    if (yearEndInFlight) return yearEndInFlight;
    if (
      yearEndFailedAt !== null &&
      Date.now() - yearEndFailedAt < YEAR_END_FAILURE_THROTTLE_MS
    ) {
      // A live attempt failed moments ago. Hand back the same value a fresh
      // failing attempt would produce, without making the call — see
      // YEAR_END_FAILURE_THROTTLE_MS. Nothing is pinned: the very next call
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

export interface XeroConnectedOrganisation {
  name: string | null;
  financialYearEndMonth: number | null;
  /**
   * Xero's organisation short code (e.g. `!aBc12`), or null when unavailable.
   * Callers must treat null as "build the generic go.xero.com link" — never as
   * a reason to hide or disable the link.
   */
  shortCode: string | null;
}

/** Empty summary: the shape a failed/never-run read degrades to. */
const EMPTY_ORG_SUMMARY: XeroConnectedOrganisation = {
  name: null,
  financialYearEndMonth: null,
  shortCode: null,
};

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
        // But KEEP the transient (5xx/408) budget at withXeroRetry's default of
        // 1, because `maxTransientRetries` otherwise defaults to
        // `min(maxRetries, 1)` — so `maxRetries: 0` alone would also zero it.
        // That matters far beyond this read: exhausting the transient budget
        // calls `rememberXeroTransientOutage`, the PROCESS-GLOBAL breaker that
        // fails every subsequent Xero call fast for two minutes, invoicing and
        // sync included. A decorative read must not be able to trip that on its
        // own first 5xx; with the budget intact it takes two consecutive
        // transient failures, exactly as it did before this feature existed.
        maxTransientRetries: 1,
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
      },
      false,
    );
  } catch (error) {
    logger.warn(
      { err: error },
      "Failed to read Xero connected organisation summary",
    );
    // Negative-cache the failure, keeping the last known summary as the served
    // value so a transient blip does not blank a name we already have.
    return remember(orgSummaryCache?.summary ?? EMPTY_ORG_SUMMARY, true);
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
 * Parse a Xero lock-date value into a date-only Date, or null when unset or
 * unparseable. xero-node TYPES these fields as optional strings, but its
 * ObjectSerializer converts any string payload starting with `/Date(` into a
 * JS Date at runtime (deserializeDateFormats), so when an organisation has a
 * lock date set the value arrives here as a Date object. A raw string can
 * still appear as a Microsoft-JSON `/Date(1234567890000+1300)/` timestamp or
 * an ISO date string, so all three shapes must parse.
 */
function parseXeroLockDate(value: string | Date | undefined | null): Date | null {
  if (!value) return null;

  if (value instanceof Date) {
    if (!Number.isNaN(value.getTime())) {
      // Normalize to a date-only Date in UTC, matching the MS-JSON path below.
      const parsed = parseDateOnly(value.toISOString().slice(0, 10));
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    logger.warn({ value }, "Unparseable Xero lock date; treating as unset");
    return null;
  }

  const msJson = /\/Date\((\d+)/.exec(value);
  if (msJson) {
    const epochMs = Number(msJson[1]);
    if (Number.isFinite(epochMs)) {
      // Normalize to a date-only Date in UTC (lock dates are whole days).
      const parsed = parseDateOnly(new Date(epochMs).toISOString().slice(0, 10));
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
  } else {
    const parsed = parseDateOnly(value.slice(0, 10));
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  // A SET but unrecognisable lock date must not silently disable the guard —
  // treat-as-unset fails open, so make the format drift loud.
  logger.warn({ value }, "Unparseable Xero lock date; treating as unset");
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
  // reconnect must go live on the very next call, not wait the window out.
  yearEndFailedAt = null;
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
