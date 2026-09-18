/**
 * ENFORCES INV-PRIV-014 (`docs/invariants/analytics-and-privacy.md`).
 *
 * THE RULE. A Diagnostics operator's applied page filters and typed free-text
 * search leave this application to the third-party AI model provider on EVERY
 * Diagnostics question, ungated by either consent tick. The record-details tick
 * (`allowRecordPersonalDetails`) governs the selected record's identifying
 * fields; the people-search tick (`allowPeopleSearch`) governs whether tools may
 * search for people — NEITHER governs the page-filter/search view context.
 *
 * WHAT THIS GUARD DRIVES, and where it stops. It exercises the REAL page-context
 * pipeline end to end from the ask route: `matchDiagnosticsPageRoute`,
 * `resolveDiagnosticsPageContext` (its `buildSelection` and the record
 * projection), and `renderPageContextEvidenceBlock` / `buildPageContextUserTurn`
 * are all the production code. Only the OUTER boundary is mocked — the session
 * guard, rate limits, readiness, the fresh permission matrix, the record
 * projection reader, and the answer loop. It captures the `pageContextBlock`
 * string the route hands to `runDiagnosticsAnswer`, which is exactly the text
 * `answer/loop.ts` (line ~204) pushes into the FIRST USER TURN of the provider
 * request — so "reaches the provider" is pinned at that assembly boundary, not by
 * inspecting a live HTTP body to Anthropic. It does NOT prove anything about what
 * the provider does with the text; it proves what this application sends.
 *
 * WHY END-TO-END rather than a source scan. The property is a data-flow one — a
 * value present in the request independent of two flags — and the honest way to
 * pin it is to send a distinctive typed search value through the real narrowing,
 * allowlisting, redaction and rendering and assert it arrives, for every
 * combination of the two ticks. A mutation that gates the view on a tick turns
 * the matrix assertion red.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminPermissionMatrix } from "@/lib/admin-permissions";
import type { DiagnosticsPageContextFact } from "@/lib/diagnostics/page-context/types";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  applyRateLimit: vi.fn(),
  checkRateLimit: vi.fn(),
  rateLimitedResponse: vi.fn(),
  readModuleFlag: vi.fn(),
  readiness: vi.fn(),
  apiKey: vi.fn(),
  meteringHealthy: vi.fn(),
  freshMatrix: vi.fn(),
  readRecordProjection: vi.fn(),
  runAnswer: vi.fn(),
  loadBundle: vi.fn(),
}));

// The OUTER boundary only. Everything under `page-context/` except the fresh
// matrix read and the record projection is the real module, so the view really
// is narrowed, allowlisted, redacted and rendered by production code.
vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: mocks.applyRateLimit,
  checkRateLimit: mocks.checkRateLimit,
  rateLimitedResponse: mocks.rateLimitedResponse,
  rateLimiters: {
    aiDiagnosticsIp: { id: "ai-diagnostics-ip" },
    aiDiagnosticsAdmin: { id: "ai-diagnostics-admin" },
    aiDiagnosticsGlobal: { id: "ai-diagnostics-global" },
  },
}));
vi.mock("@/lib/ai-diagnostics-config", () => ({
  readDiagnosticsModuleFlag: mocks.readModuleFlag,
  getDiagnosticsReadiness: mocks.readiness,
  getOperationalDiagnosticsApiKey: mocks.apiKey,
}));
vi.mock("@/lib/ai-diagnostics-usage", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/ai-diagnostics-usage")),
  isDiagnosticsMeteringHealthy: mocks.meteringHealthy,
}));
// PARTIAL: keep the real `hasAllAreaViews`/`missingAreaViews` the resolver uses
// to gate on permission, override only the database-backed fresh matrix read
// that both the route (gate 7) and the resolver (gate 2) call.
vi.mock("@/lib/diagnostics/page-context/authorize", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/diagnostics/page-context/authorize")),
  readFreshAdminPermissionMatrix: mocks.freshMatrix,
}));
// Stub only the record READER, so the resolver runs for real without a database.
// `resolve.ts` imports nothing else from this module.
vi.mock("@/lib/diagnostics/page-context/projections", () => ({
  readRecordProjection: mocks.readRecordProjection,
}));
vi.mock("@/lib/diagnostics/answer/loop", () => ({
  runDiagnosticsAnswer: mocks.runAnswer,
}));
vi.mock("@/lib/diagnostics/knowledge/load", () => ({
  loadKnowledgeBundle: mocks.loadBundle,
}));
vi.mock("@/lib/observability-bridge", () => ({ reportAiError: vi.fn() }));

import { POST } from "../route";

/** A full admin matrix — every area at `view` — so permission never denies. */
const FULL_MATRIX: AdminPermissionMatrix = {
  overview: "view",
  bookings: "view",
  membership: "view",
  finance: "view",
  lodge: "view",
  content: "view",
  support: "view",
};

const OK_SUMMARY = {
  complete: true,
  hasWithheldEvidence: false,
  withheldAreas: [],
  hasConsentWithheld: false,
  hasSearchWithheld: false,
  hasAuthoritativeBlocker: false,
  hasInferredBlockerOnly: false,
  states: [],
};

/**
 * A distinctive, unmistakably non-PII typed search term. It has no `@` and no
 * 8+ digit run, so the free-text redactor (`boundedRedacted`) passes it through
 * verbatim — the point of the test is that THIS reaches the provider.
 */
const TYPED_SEARCH = "unpaiddepositquery";
const RECORD_ID = "clx0123456789abcdefgh";

function body(overrides: Record<string, unknown> = {}) {
  return {
    // `/admin/bookings` is the one route that carries BOTH a record kind
    // (`booking`) AND an allowlisted view (`status`, and a `search` filter key),
    // so a single question demonstrates the ungated view and the tick-governed
    // record boundary at once.
    pathname: "/admin/bookings",
    question: "why is this booking not confirming?",
    transcript: [],
    recordId: RECORD_ID,
    allowPeopleSearch: false,
    allowRecordPersonalDetails: false,
    view: {
      status: "PAYMENT_PENDING",
      filters: { search: TYPED_SEARCH, checkInFrom: "2026-08-01" },
    },
    ...overrides,
  };
}

function request(payload: unknown) {
  return new Request("https://example.test/api/admin/ai-diagnostics/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/**
 * The `pageContextBlock` string the route handed to the answer loop on its
 * `nth` call — i.e. the page-context text that becomes the first user turn of
 * the provider request.
 */
function providerBlock(nth: number): string {
  const call = mocks.runAnswer.mock.calls[nth];
  expect(
    call,
    "INV-PRIV-014 (docs/invariants/analytics-and-privacy.md): the answer loop " +
      `was not reached on call #${nth}, so no page context could have travelled ` +
      "to the provider.",
  ).toBeDefined();
  return call[0].pageContextBlock as string;
}

/** Strip the one non-deterministic part (the resolver's observed-at instant). */
function withoutInstant(block: string): string {
  return block
    .replace(/observed-at="[^"]*"/g, 'observed-at="<t>"')
    .replace(/read at [0-9TZ:.\-]+/g, "read at <t>");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "member-1" } },
  });
  mocks.applyRateLimit.mockResolvedValue(null);
  mocks.checkRateLimit.mockResolvedValue({ success: true });
  mocks.readModuleFlag.mockResolvedValue(true);
  mocks.meteringHealthy.mockReturnValue(true);
  mocks.readiness.mockResolvedValue({
    ready: true,
    moduleEnabled: true,
    keyState: "saved",
    monthlyBudgetCents: 5000,
    databaseState: "verified",
    blockers: [],
  });
  mocks.apiKey.mockResolvedValue("sk-diagnostics");
  mocks.freshMatrix.mockResolvedValue({ ok: true, matrix: FULL_MATRIX });
  // A fixed booking projection. The render's personal-detail line keys on the
  // resolver's `sensitiveIncluded` (driven by the record tick), not on these
  // facts, so a constant projection is enough to exercise the contrast.
  mocks.readRecordProjection.mockResolvedValue([
    { key: "status", value: "PAYMENT_PENDING", sensitive: false },
  ] satisfies DiagnosticsPageContextFact[]);
  mocks.loadBundle.mockResolvedValue({ ok: false, reason: "missing" });
  mocks.runAnswer.mockResolvedValue({
    ok: true,
    answer: "The deposit is unpaid.",
    truncated: false,
    sources: [],
    summary: OK_SUMMARY,
    roundsUsed: 1,
  });
});

describe("INV-PRIV-014: the page view reaches the provider ungated by either consent tick (#2816)", () => {
  // The four combinations of the two per-question ticks. For every one of them
  // the operator's applied status and typed search must reach the provider.
  const TICK_MATRIX = [
    { allowPeopleSearch: false, allowRecordPersonalDetails: false },
    { allowPeopleSearch: true, allowRecordPersonalDetails: false },
    { allowPeopleSearch: false, allowRecordPersonalDetails: true },
    { allowPeopleSearch: true, allowRecordPersonalDetails: true },
  ] as const;

  it.each(TICK_MATRIX)(
    "sends the applied status and typed search with allowPeopleSearch=$allowPeopleSearch, allowRecordPersonalDetails=$allowRecordPersonalDetails",
    async (ticks) => {
      const response = await POST(request(body(ticks)));
      expect(response.status).toBe(200);

      const block = providerBlock(0);

      // The typed free-text SEARCH the operator entered, verbatim in the block
      // bound for the provider — the load-bearing half of the rule.
      expect(
        block,
        "INV-PRIV-014 (docs/invariants/analytics-and-privacy.md): the operator's " +
          "typed free-text search did not reach the provider request with ticks " +
          `${JSON.stringify(ticks)}. It must travel on EVERY question, ungated by ` +
          "either consent tick.",
      ).toContain(`filter search: ${TYPED_SEARCH}`);

      // An applied filter TOKEN — the normalised status — travels too.
      expect(
        block,
        "INV-PRIV-014 (docs/invariants/analytics-and-privacy.md): the operator's " +
          "applied page filter (status) did not reach the provider with ticks " +
          `${JSON.stringify(ticks)}.`,
      ).toContain("status: payment-pending");
    },
  );

  it("keeps the view identical whether or not the people-search tick is set", async () => {
    // The people-search tick governs the answer loop's people/record tools, never
    // the view. Toggle only people-search: the view portion of the provider block
    // must be identical once the resolver's timestamp is normalised.
    await POST(request(body({ allowPeopleSearch: false })));
    await POST(request(body({ allowPeopleSearch: true })));

    expect(
      withoutInstant(providerBlock(1)),
      "INV-PRIV-014 (docs/invariants/analytics-and-privacy.md): toggling the " +
        "people-search tick changed the page-context view sent to the provider. " +
        "That tick governs people/record tools, never the view.",
    ).toBe(withoutInstant(providerBlock(0)));
  });

  it("gates ONLY the selected record's personal detail on the record tick, never the view", async () => {
    // The contrast that proves the boundary the ticks DO govern. Same page, same
    // filters; only the record-details tick moves. The VIEW lines are unchanged
    // while the record's personal-detail disclosure line flips.
    await POST(request(body({ allowRecordPersonalDetails: false })));
    await POST(request(body({ allowRecordPersonalDetails: true })));

    const omitted = providerBlock(0);
    const included = providerBlock(1);

    // The view travels in BOTH cases, untouched by the record tick.
    expect(omitted).toContain(`filter search: ${TYPED_SEARCH}`);
    expect(included).toContain(`filter search: ${TYPED_SEARCH}`);

    // The record's personal-detail disclosure is exactly what the tick governs.
    expect(omitted).toContain("personal detail omitted");
    expect(omitted).not.toContain("personal detail included by operator opt-in");
    expect(
      included,
      "INV-PRIV-014 (docs/invariants/analytics-and-privacy.md): the record tick " +
        "must govern the selected record's personal-detail disclosure.",
    ).toContain("personal detail included by operator opt-in");
  });
});
