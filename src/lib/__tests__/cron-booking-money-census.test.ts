import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ reportCronError: vi.fn() }));

// Every dependency is injected, so no test here reaches a database.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/observability-bridge", () => ({ reportCronError: mocks.reportCronError }));

import {
  summarizeBookingLedgerCensus,
  type BookingLedgerCensusReport,
} from "@/lib/booking-ledger-projection-census-report";
import { CENSUS_PAGE_SIZE } from "@/lib/booking-ledger-projection-census-store";
import {
  BOOKING_MONEY_CENSUS_IDS_PER_CLASS,
  parseBookingMoneyCensusSummary,
} from "@/lib/booking-money-census-summary";
import {
  BOOKING_MONEY_RECONCILIATION_REASON_ORDER,
  type BookingMoneyReconciliationSummary,
} from "@/lib/booking-money-reconciliation";
import { requireClubTimeZone } from "@/lib/club-time";
import { runBookingMoneyCensus, type BookingMoneyCensusDependencies } from "@/lib/cron-booking-money-census";

const ZONE = requireClubTimeZone("Pacific/Auckland");
const NOW = new Date("2026-07-01T00:00:00.000Z");
const DELIVERED = { deliveryAllowed: true, recipients: 1, sent: 1, queuedForRetry: 0, notDelivered: 0, failedBeforeLogged: 0 };

/** A census report with nothing wrong, as the real summariser builds it for no bookings. */
function cleanReport(): BookingLedgerCensusReport {
  return summarizeBookingLedgerCensus([], null);
}

/** A report holding one finding of each kind: a disagreement, a coverage gap, an integrity finding and a known class. */
function driftReport(): BookingLedgerCensusReport {
  const report = cleanReport();
  report.population.bookings = 7;
  report.disagreements.push({ bookingId: "bk-captured", identity: "CAPTURED", columnCents: 5000, ledgerCents: 4000, deltaCents: 1000 });
  report.coverage.NO_LINES.push("bk-no-lines");
  report.integrity.findings.push({ bookingId: "bk-drift", lineId: "line-1", kind: "SOURCE_DRIFT", detail: "moved" });
  report.classes.NOTHING_CAPTURED.instances.push({ bookingId: "bk-known", identity: "CAPTURED", cents: 300, acknowledged: false });
  report.unacknowledgedClassInstances = 1;
  report.verdict = "GATE_CLOSED";
  return report;
}

function moneyTotals(unreconciled = 0): BookingMoneyReconciliationSummary {
  const byReason = Object.fromEntries(BOOKING_MONEY_RECONCILIATION_REASON_ORDER.map((reason) => [reason, 0])) as BookingMoneyReconciliationSummary["byReason"];
  byReason.HEADLINE_TOTAL_MISMATCH = unreconciled;
  return { totalBookings: 7, byState: { RECONCILED: 7 - unreconciled, UNRECONCILED: unreconciled }, byReason };
}

function buildDeps(overrides: Partial<BookingMoneyCensusDependencies> = {}) {
  const deps = {
    readZone: vi.fn(async () => ZONE),
    readJournalInactive: vi.fn(async () => null as string | null),
    censusLedger: vi.fn(async () => cleanReport()),
    censusMoney: vi.fn(async () => moneyTotals()),
    findHeldKeys: vi.fn(async () => new Set<string>()),
    readClaimState: vi.fn(async () => "none" as const),
    // Like the real helper: claims, runs the send, and keeps the claim when someone was sent it.
    sendOnceEver: vi.fn(async ({ send }: { send: () => Promise<unknown> }) => {
      await send();
      return true;
    }),
    sendAlert: vi.fn(async () => DELIVERED),
    stampSent: vi.fn(async () => undefined),
    now: () => NOW,
    ...overrides,
  } satisfies BookingMoneyCensusDependencies;
  return deps;
}

const ALL_KEYS = [
  "booking-money-census:class:NOTHING_CAPTURED:bk-known",
  "booking-money-census:coverage:NO_LINES:bk-no-lines",
  "booking-money-census:disagreement:CAPTURED:bk-captured",
  "booking-money-census:integrity:SOURCE_DRIFT:bk-drift",
];

beforeEach(() => {
  mocks.reportCronError.mockReset();
});

describe("#4910 runBookingMoneyCensus: the nightly booking money check", () => {
  it("records a clean summary and sends nothing when the records agree", async () => {
    const deps = buildDeps();

    const summary = await runBookingMoneyCensus(deps);

    expect(summary).toMatchObject({
      verdict: "GATE_OPEN",
      findings: 0,
      drift: 0,
      unacknowledgedClassInstances: 0,
      classes: [],
      alert: { newFindings: 0, sent: false, failed: false },
    });
    expect(deps.sendOnceEver).not.toHaveBeenCalled();
    expect(deps.sendAlert).not.toHaveBeenCalled();
    expect(deps.stampSent).not.toHaveBeenCalled();
  });

  it("reads the zone and the journal state first, and hands each census what the operator command hands it", async () => {
    const deps = buildDeps({ readJournalInactive: vi.fn(async () => "currency cannot be charged by card") });

    await runBookingMoneyCensus(deps);

    expect(deps.censusLedger).toHaveBeenCalledWith({ journalInactive: "currency cannot be charged by card", pageSize: CENSUS_PAGE_SIZE });
    expect(deps.censusMoney).toHaveBeenCalledWith(ZONE);
    expect(deps.readZone.mock.invocationCallOrder[0]).toBeLessThan(deps.censusLedger.mock.invocationCallOrder[0]);
    expect(deps.readJournalInactive.mock.invocationCallOrder[0]).toBeLessThan(deps.censusLedger.mock.invocationCallOrder[0]);
  });

  it("alerts once for a night's new findings, names them by class and booking, and stamps each", async () => {
    const deps = buildDeps({ censusLedger: vi.fn(async () => driftReport()), censusMoney: vi.fn(async () => moneyTotals(2)) });

    const summary = await runBookingMoneyCensus(deps);

    expect(deps.sendOnceEver).toHaveBeenCalledTimes(1);
    expect(deps.sendOnceEver.mock.calls[0][0]).toMatchObject({ key: expect.stringMatching(/^booking-money-census:digest:[0-9a-f]{32}$/) });
    expect(deps.sendAlert).toHaveBeenCalledWith({
      newFindings: 4,
      classes: [
        { class: "disagreement:CAPTURED", group: "disagreement", count: 1, bookingIds: ["bk-captured"] },
        { class: "coverage:NO_LINES", group: "coverage", count: 1, bookingIds: ["bk-no-lines"] },
        { class: "integrity:SOURCE_DRIFT", group: "integrity", count: 1, bookingIds: ["bk-drift"] },
        { class: "class:NOTHING_CAPTURED", group: "class", count: 1, bookingIds: ["bk-known"] },
      ],
    });
    expect(deps.stampSent.mock.calls.map(([key]) => key)).toEqual(ALL_KEYS);
    expect(summary).toMatchObject({
      verdict: "GATE_CLOSED",
      bookingsChecked: 7,
      findings: 4,
      // The known class awaits the owner; it is not drift.
      drift: 3,
      unacknowledgedClassInstances: 1,
      reconciliation: { totalBookings: 7, reconciled: 5, unreconciled: 2, byReason: { HEADLINE_TOTAL_MISMATCH: 2 } },
      alert: { newFindings: 4, sent: true, failed: false },
    });
  });

  it("stores a summary the dashboard's reader accepts after the JSON round trip the scheduler makes", async () => {
    const deps = buildDeps({ censusLedger: vi.fn(async () => driftReport()), censusMoney: vi.fn(async () => moneyTotals(2)) });

    const summary = await runBookingMoneyCensus(deps);

    expect(parseBookingMoneyCensusSummary(JSON.parse(JSON.stringify(summary)))).toEqual(summary);
  });

  it("leaves out a finding already alerted, and sends nothing on a night with only known findings", async () => {
    const heldOne = buildDeps({
      censusLedger: vi.fn(async () => driftReport()),
      findHeldKeys: vi.fn(async () => new Set(["booking-money-census:disagreement:CAPTURED:bk-captured"])),
    });

    const partly = await runBookingMoneyCensus(heldOne);

    expect(heldOne.sendAlert.mock.calls[0][0].classes.map((entry) => entry.class)).toEqual([
      "coverage:NO_LINES",
      "integrity:SOURCE_DRIFT",
      "class:NOTHING_CAPTURED",
    ]);
    expect(heldOne.stampSent.mock.calls.map(([key]) => key)).not.toContain("booking-money-census:disagreement:CAPTURED:bk-captured");
    // The summary still reports every finding; only the alert is once-only.
    expect(partly).toMatchObject({ findings: 4, alert: { newFindings: 3, sent: true } });

    const heldAll = buildDeps({
      censusLedger: vi.fn(async () => driftReport()),
      findHeldKeys: vi.fn(async (keys: readonly string[]) => new Set(keys)),
    });

    const quiet = await runBookingMoneyCensus(heldAll);

    expect(heldAll.sendOnceEver).not.toHaveBeenCalled();
    expect(heldAll.stampSent).not.toHaveBeenCalled();
    expect(quiet).toMatchObject({ findings: 4, alert: { newFindings: 0, sent: false, failed: false } });
  });

  it("stamps nothing when nobody could be sent the alert, so the next night tries again", async () => {
    const deps = buildDeps({
      censusLedger: vi.fn(async () => driftReport()),
      sendOnceEver: vi.fn(async () => false),
      readClaimState: vi.fn(async () => "deferred" as const),
    });

    const summary = await runBookingMoneyCensus(deps);

    expect(deps.stampSent).not.toHaveBeenCalled();
    expect(summary.alert).toEqual({ newFindings: 4, sent: false, failed: false });
  });

  it("stamps without sending again when an earlier night's email for the same findings was kept", async () => {
    const deps = buildDeps({
      censusLedger: vi.fn(async () => driftReport()),
      // The claim is already held, so the helper sends nothing.
      sendOnceEver: vi.fn(async () => false),
      readClaimState: vi.fn(async () => "kept" as const),
    });

    const summary = await runBookingMoneyCensus(deps);

    expect(deps.sendAlert).not.toHaveBeenCalled();
    expect(deps.stampSent.mock.calls.map(([key]) => key)).toEqual(ALL_KEYS);
    expect(summary.alert).toEqual({ newFindings: 4, sent: false, failed: false });
  });

  it("names at most twenty bookings per class in the summary and the alert, with the full count", async () => {
    const report = cleanReport();
    for (let index = 0; index < 25; index += 1) report.coverage.UNPOSTED_EDIT.push(`bk-${String(index).padStart(2, "0")}`);
    const deps = buildDeps({ censusLedger: vi.fn(async () => report) });

    const summary = await runBookingMoneyCensus(deps);

    expect(summary.classes).toHaveLength(1);
    expect(summary.classes[0]).toMatchObject({ class: "coverage:UNPOSTED_EDIT", count: 25 });
    expect(summary.classes[0].bookingIds).toHaveLength(BOOKING_MONEY_CENSUS_IDS_PER_CLASS);
    expect(deps.sendAlert.mock.calls[0][0].classes[0].bookingIds).toHaveLength(BOOKING_MONEY_CENSUS_IDS_PER_CLASS);
    // Every finding is stamped, named in the email or not: the email gave its count.
    expect(deps.stampSent).toHaveBeenCalledTimes(25);
  });

  it("reports a booking once per class, and never a class the census only lists", async () => {
    const report = cleanReport();
    // Two lines of one booking in one integrity kind; two instances of one known class on one booking.
    report.integrity.findings.push(
      { bookingId: "bk-1", lineId: "line-1", kind: "SOURCE_DRIFT", detail: "a" },
      { bookingId: "bk-1", lineId: "line-2", kind: "SOURCE_DRIFT", detail: "b" },
    );
    report.classes.NOTHING_CAPTURED.instances.push(
      { bookingId: "bk-2", identity: "CAPTURED", cents: 100, acknowledged: false },
      { bookingId: "bk-2", identity: "OWED", cents: 100, acknowledged: false },
    );
    // `GROUP_SETTLEMENT_OFF_LEDGER` is listed only: it never holds the census's gate.
    report.classes.GROUP_SETTLEMENT_OFF_LEDGER.instances.push({ bookingId: "bk-3", identity: null, cents: 0, acknowledged: false });
    // The journal-inactive finding is about the club, not a booking.
    report.integrity.findings.push({ bookingId: "", lineId: "", kind: "JOURNAL_INACTIVE", detail: "currency" });
    const deps = buildDeps({ censusLedger: vi.fn(async () => report) });

    const summary = await runBookingMoneyCensus(deps);

    expect(summary.classes).toEqual([
      { class: "integrity:SOURCE_DRIFT", group: "integrity", count: 1, bookingIds: ["bk-1"] },
      { class: "integrity:JOURNAL_INACTIVE", group: "integrity", count: 1, bookingIds: [] },
      { class: "class:NOTHING_CAPTURED", group: "class", count: 1, bookingIds: ["bk-2"] },
    ]);
    expect(deps.stampSent.mock.calls.map(([key]) => key)).toContain("booking-money-census:integrity:JOURNAL_INACTIVE:club");
  });

  it("fails the run when a census throws, so the scheduler records FAILURE", async () => {
    const deps = buildDeps({ censusLedger: vi.fn(async () => Promise.reject(new Error("snapshot timed out"))) });

    await expect(runBookingMoneyCensus(deps)).rejects.toThrow("snapshot timed out");
    expect(deps.sendOnceEver).not.toHaveBeenCalled();

    const moneyFails = buildDeps({ censusMoney: vi.fn(async () => Promise.reject(new Error("money census failed"))) });
    await expect(runBookingMoneyCensus(moneyFails)).rejects.toThrow("money census failed");
  });

  it("keeps the summary and reports the fault when only the alert step fails", async () => {
    const deps = buildDeps({
      censusLedger: vi.fn(async () => driftReport()),
      findHeldKeys: vi.fn(async () => Promise.reject(new Error("alert store down"))),
    });

    const summary = await runBookingMoneyCensus(deps);

    expect(summary).toMatchObject({ findings: 4, drift: 3, alert: { newFindings: 0, sent: false, failed: true } });
    expect(deps.sendOnceEver).not.toHaveBeenCalled();
    expect(mocks.reportCronError).toHaveBeenCalledTimes(1);
  });
});
