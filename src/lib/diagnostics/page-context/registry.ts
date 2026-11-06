/**
 * AI Diagnostics — the page-context ROUTE REGISTRY (AID-4, epic #2369, #2373).
 *
 * This table is the whole allowlist. A client selector names a `key` in it or is
 * rejected; nothing about a page is accepted from the client except which of
 * these rows it is on, one opaque record id, and tokens this row explicitly
 * permits.
 *
 * FAIL-CLOSED BY CONSTRUCTION. Every token allowlist defaults to EMPTY, and an
 * empty allowlist means the field is REFUSED for that route — not "anything
 * goes". Adding a page therefore starts from "no tabs, no steps, no statuses, no
 * error codes, no filters, no record" and widens one field at a time, which is
 * the opposite of the flat Page help string this replaces.
 *
 * AUTHORIZATION (ADR-002). `requiredAreas` is a CONJUNCTION: the caller needs
 * `view` on every listed area, re-read fresh from the database on every
 * resolution. It is never the union, and it may never be weaker than the admin
 * route lattice's own requirement for `pathname` — pinned by
 * `registry.test.ts`, which resolves each `pathname` through
 * `getAdminRouteRequirement` and asserts the lattice's area is present here. It
 * resolves each `steps` token as a SUB-PATH of `pathname` too, because a step that
 * names a sub-page gated on a different area (as `/admin/setup/finance` is) would
 * otherwise pass a guard that only ever looks at the parent path.
 *
 * FILTER KEYS ARE THE PAGE'S REAL QUERY PARAMETERS, and a subset of them: the
 * client must send only allowlisted keys, because rejection is total (`parse.ts`)
 * and one unlisted key costs the operator their whole page context. Pagination and
 * sort keys are deliberately excluded — they say nothing about why a page shows
 * what it shows.
 *
 * The registry is intentionally SMALL. A page belongs here when an operator
 * plausibly asks "why is this page showing me this?", not merely because it
 * exists; every row is a place personal data could be re-read, so each one is a
 * deliberate decision.
 */

import { BOOKING_REQUESTS_TABS } from "@/lib/admin-booking-requests-path";
import type { AdminPermissionArea } from "@/lib/admin-permissions";
import type { StuckStateSeverity } from "@/lib/stuck-state-dashboard";

import type { DiagnosticsRecordKind } from "./types";

/**
 * The generic, operator-visible failure codes a page may report. Closed, small,
 * and deliberately transport-level rather than domain-level: these are the words
 * an admin actually repeats back ("it said Forbidden"), and a domain-specific
 * vocabulary would drift the moment a feature renamed one of its errors.
 */
export const DIAGNOSTICS_PAGE_ERROR_CODES = [
  "unauthorized",
  "forbidden",
  "not-found",
  "conflict",
  "validation-failed",
  "rate-limited",
  "timeout",
  "server-error",
  "network-error",
] as const;

/** One of the closed set above. Exported so a publishing page can be typed by it. */
export type DiagnosticsPageErrorCode =
  (typeof DIAGNOSTICS_PAGE_ERROR_CODES)[number];

/**
 * Booking lifecycle statuses, mirrored from the `BookingStatus` Prisma enum.
 * Held as a literal (rather than imported from `@prisma/client`) so this module
 * stays free of the generated client and can be read from a client component;
 * `registry.test.ts` asserts it still equals the enum, so it cannot drift.
 */
const BOOKING_STATUS_TOKENS = [
  "draft",
  "pending",
  "payment-pending",
  "confirmed",
  "paid",
  "bumped",
  "cancelled",
  "completed",
  "waitlisted",
  "waitlist-offered",
  "awaiting-review",
] as const;

/** Payment statuses, mirrored from the `PaymentStatus` Prisma enum (as above). */
const PAYMENT_STATUS_TOKENS = [
  "pending",
  "processing",
  "succeeded",
  "failed",
  "refunded",
  "partially-refunded",
] as const;

/**
 * Stuck-state severities. `StuckStateSeverity` is a hand-written TS union rather
 * than a generated enum, so there is no Prisma value to compare against at
 * runtime the way the two status lists above are compared. `satisfies` pins the
 * forward direction at COMPILE time (a token that is not a severity fails to
 * build); `registry.test.ts` pins the reverse direction, that no severity is
 * missing from this list. The import is type-only, so this module still carries no
 * runtime dependency on the dashboard.
 */
const STUCK_STATE_SEVERITY_TOKENS = [
  "critical",
  "warning",
  "info",
] as const satisfies readonly StuckStateSeverity[];

export interface DiagnosticsPageContextRoute {
  /** Stable registry key. The ONLY route identifier a client may send. */
  key: string;
  /**
   * The canonical admin pathname this row describes, `[id]`-style segments
   * included. Server-owned: it is echoed into the evidence for citation and
   * checked against the admin route lattice, never parsed from client input.
   */
  pathname: string;
  /** Plain-English page name, for the evidence block and the UI. */
  label: string;
  /** Admin areas required at `view`, ALL of them (AND). Never empty. */
  requiredAreas: readonly AdminPermissionArea[];
  /**
   * The record kind this page's `recordId` selects, or `null` when the page
   * takes no record. The client picks the ID; the SERVER picks the KIND — which
   * is why a member id sent on a booking route can only ever fail to find a
   * booking, never read a member.
   */
  recordKind: DiagnosticsRecordKind | null;
  tabs: readonly string[];
  steps: readonly string[];
  statuses: readonly string[];
  errorCodes: readonly string[];
  filterKeys: readonly string[];
}

const EMPTY: readonly string[] = [];

function route(
  input: Omit<
    DiagnosticsPageContextRoute,
    "tabs" | "steps" | "statuses" | "errorCodes" | "filterKeys"
  > &
    Partial<
      Pick<
        DiagnosticsPageContextRoute,
        "tabs" | "steps" | "statuses" | "errorCodes" | "filterKeys"
      >
    >,
): DiagnosticsPageContextRoute {
  return {
    tabs: EMPTY,
    steps: EMPTY,
    statuses: EMPTY,
    errorCodes: EMPTY,
    filterKeys: EMPTY,
    ...input,
  };
}

const ROUTES: readonly DiagnosticsPageContextRoute[] = [
  route({
    key: "admin.dashboard",
    pathname: "/admin/dashboard",
    label: "Admin dashboard",
    requiredAreas: ["overview"],
    recordKind: null,
    errorCodes: DIAGNOSTICS_PAGE_ERROR_CODES,
  }),
  route({
    key: "admin.bookings",
    pathname: "/admin/bookings",
    label: "Bookings list",
    requiredAreas: ["bookings"],
    recordKind: "booking",
    statuses: BOOKING_STATUS_TOKENS,
    errorCodes: DIAGNOSTICS_PAGE_ERROR_CODES,
    // THE FOUR PRECISE DATE KEYS, and deliberately NOT the legacy `from`/`to`
    // pair this page also accepts (evidence review of PR #2831, 14 Aug 2026).
    // `buildBookingWhere` is ASYMMETRIC about that pair — legacy `from` feeds
    // `checkIn.gte` while legacy `to` feeds `checkOut.lte` — and the page has
    // four date bounds to describe with them. So a bound published under `to`
    // meant "check-out upper bound" in this page's URL and in its deployed
    // source, while `?month=2026-08` put a check-IN upper bound there: a model
    // reading the source excerpt then names the wrong bookings for the flagship
    // "why isn't this booking showing?" question. A filter key has to have ONE
    // meaning, so the ambiguous pair is retired from this row's vocabulary and
    // `appliedBookingViewFilters` publishes under the column it actually bounded.
    filterKeys: [
      "lodgeId",
      "status",
      "checkInFrom",
      "checkInTo",
      "checkOutFrom",
      "checkOutTo",
      "search",
    ],
  }),
  route({
    // #2812: this row used to be `admin.booking-approvals` at
    // `/admin/booking-approvals` — a pathname whose page is a fifteen-line
    // redirect() shim, so the row could never match a live page and the
    // approvals queue (the single most likely place to ask "why will this
    // booking not confirm?") had no page context at all. It now names the page
    // an operator actually stands on. The tab list is the page's own canonical
    // set, imported rather than retyped (owner decision 13 Aug 2026: every
    // tab, not approvals-only).
    key: "admin.booking-requests",
    pathname: "/admin/booking-requests",
    label: "Booking requests and approvals",
    requiredAreas: ["bookings"],
    recordKind: "booking",
    tabs: BOOKING_REQUESTS_TABS,
    // NO status vocabulary, deliberately (review finding, 13 Aug 2026). The dead
    // row carried BOOKING_STATUS_TOKENS, but this page's own `?status=` values are
    // REVIEW filters (`PENDING`/`APPROVED`/`REJECTED`/`ALL`, plus `REQUESTED` on
    // the exceptions deep link) — a different vocabulary, and the booking-status
    // census forces any non-empty list here to equal the whole BookingStatus enum.
    // Advertising tokens the page never uses would cost an operator their entire
    // context the moment #2816 wires view state (rejection is total). Empty means
    // refused, which is the registry's honest fail-closed default; widening it is
    // a decision for whoever wires this page's view state.
    errorCodes: DIAGNOSTICS_PAGE_ERROR_CODES,
  }),
  route({
    key: "admin.waitlist",
    pathname: "/admin/waitlist",
    label: "Waitlist",
    requiredAreas: ["bookings"],
    recordKind: "booking",
    statuses: BOOKING_STATUS_TOKENS,
    errorCodes: DIAGNOSTICS_PAGE_ERROR_CODES,
    // The waitlist has no lodge dimension: its only operator-set filters are the
    // date window (`page`/`pageSize` excluded as pagination).
    filterKeys: ["from", "to"],
  }),
  route({
    // The one genuinely cross-area row: bed allocation reads the bookings being
    // placed AND the lodge's own room/bed structure, so it needs `view` on both
    // (ADR-002 §3 — AND, never OR).
    key: "admin.bed-allocation",
    pathname: "/admin/bed-allocation",
    label: "Bed allocation",
    requiredAreas: ["bookings", "lodge"],
    recordKind: null,
    errorCodes: DIAGNOSTICS_PAGE_ERROR_CODES,
    // The board window is `from`/`to`; there is no single `date` parameter.
    filterKeys: ["lodgeId", "from", "to"],
  }),
  route({
    key: "admin.members",
    pathname: "/admin/members",
    label: "Members list",
    requiredAreas: ["membership"],
    recordKind: "member",
    errorCodes: DIAGNOSTICS_PAGE_ERROR_CODES,
    // The members list's free-text search parameter is `q`, not `search`.
    filterKeys: ["q", "ageTier"],
  }),
  route({
    key: "admin.member-detail",
    pathname: "/admin/members/[id]",
    label: "Member detail",
    requiredAreas: ["membership"],
    recordKind: "member",
    tabs: ["bookings", "xero-activity", "audit-log"],
    errorCodes: DIAGNOSTICS_PAGE_ERROR_CODES,
  }),
  route({
    key: "admin.payments",
    pathname: "/admin/payments",
    label: "Payments",
    requiredAreas: ["finance"],
    recordKind: "payment",
    statuses: PAYMENT_STATUS_TOKENS,
    errorCodes: DIAGNOSTICS_PAGE_ERROR_CODES,
    // The page has no `from`/`to`: it filters on an activity window
    // (`lastUpdatedFrom`/`lastUpdatedTo`, defaulted to the last three club-timezone
    // months) and a separate stay window. That default window is the single most
    // common reason a payment an operator expects is not on screen, so it belongs
    // in the context of "why am I not seeing this".
    filterKeys: [
      "source",
      "status",
      "search",
      "lastUpdatedFrom",
      "lastUpdatedTo",
      "checkInFrom",
      "checkInTo",
    ],
  }),
  route({
    key: "admin.stuck-states",
    pathname: "/admin/stuck-states",
    label: "Stuck states dashboard",
    requiredAreas: ["support"],
    recordKind: null,
    statuses: STUCK_STATE_SEVERITY_TOKENS,
    errorCodes: DIAGNOSTICS_PAGE_ERROR_CODES,
    // No filters: the dashboard takes no query parameters at all — domains are
    // rendered as cards, not filtered — and an empty list refuses the field.
  }),
  route({
    key: "admin.setup",
    pathname: "/admin/setup",
    label: "Guided setup",
    requiredAreas: ["support"],
    recordKind: null,
    // These are the guided-setup SUB-PAGES, not in-page steps, and each one's own
    // lattice requirement must be covered by this row. All three resolve to
    // `support`. `/admin/setup/finance` resolves to `finance` and
    // `/admin/setup/booking-rules` to `bookings` (#4581), so neither is a step
    // here — each has its own row below, gated on its own area. Widening this list
    // to either would let a support-only admin resolve context for a page the
    // lattice redirects them away from.
    steps: ["foundations", "cancellation", "integrations"],
    errorCodes: DIAGNOSTICS_PAGE_ERROR_CODES,
  }),
  route({
    // The guided-setup finance step is its own admin page with its own lattice
    // requirement: the admin layout resolves `/admin/setup/finance` to
    // `finance:view` and redirects a support-only admin away from it. So it gets
    // its own row requiring exactly `finance` — mirroring the page rather than
    // exceeding it, because a finance-only admin (who CAN open this page) would
    // otherwise be denied context for the page they are looking at. If a future
    // fact here describes the wizard's overall progress rather than the finance
    // step alone, this row needs `support` as well.
    key: "admin.setup-finance",
    pathname: "/admin/setup/finance",
    label: "Guided setup — finance",
    requiredAreas: ["finance"],
    recordKind: null,
    errorCodes: DIAGNOSTICS_PAGE_ERROR_CODES,
  }),
  route({
    // The Booking Rules hub is bookings work (#4581): the admin layout resolves
    // `/admin/setup/booking-rules` to `bookings:view`, so it gets its own row
    // requiring exactly `bookings`, mirroring the page as the finance row does.
    key: "admin.setup-booking-rules",
    pathname: "/admin/setup/booking-rules",
    label: "Guided setup — booking rules",
    requiredAreas: ["bookings"],
    recordKind: null,
    errorCodes: DIAGNOSTICS_PAGE_ERROR_CODES,
  }),
  route({
    key: "admin.health",
    pathname: "/admin/health",
    label: "System health",
    requiredAreas: ["support"],
    recordKind: null,
    errorCodes: DIAGNOSTICS_PAGE_ERROR_CODES,
  }),
];

const ROUTES_BY_KEY: ReadonlyMap<string, DiagnosticsPageContextRoute> = new Map(
  ROUTES.map((entry) => [entry.key, entry]),
);

/** Every registered route, in declaration order. */
export const DIAGNOSTICS_PAGE_CONTEXT_ROUTES = ROUTES;

/**
 * Look a route up by its key. Returns `undefined` for anything not registered —
 * there is no prefix matching, no normalisation, and no fallback route, because
 * every one of those is a way for an unlisted page to acquire a context it was
 * never reviewed for.
 */
export function getDiagnosticsPageContextRoute(
  key: string,
): DiagnosticsPageContextRoute | undefined {
  return ROUTES_BY_KEY.get(key);
}
