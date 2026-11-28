import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const mocks = vi.hoisted(() => ({
  reportCronError: vi.fn(),
  prisma: {},
  censusBookingLedgerProjection: vi.fn(),
  censusBookingMoneyReconciliation: vi.fn(),
  getClubFormat: vi.fn(),
}));

// Every dependency is injected or stood in for, so no test here reaches a database.
vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/booking-ledger-projection-census-store", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/booking-ledger-projection-census-store")),
  censusBookingLedgerProjection: mocks.censusBookingLedgerProjection,
}));
vi.mock("@/lib/booking-money-reconciliation-store", () => ({
  censusBookingMoneyReconciliation: mocks.censusBookingMoneyReconciliation,
}));
vi.mock("@/lib/club-format-settings", () => ({ getClubFormat: mocks.getClubFormat }));
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
  listBookingMoneyCensusFindings,
  parseBookingMoneyCensusSummary,
} from "@/lib/booking-money-census-summary";
import {
  BOOKING_MONEY_RECONCILIATION_REASON_ORDER,
  type BookingMoneyReconciliationSummary,
} from "@/lib/booking-money-reconciliation";
import { requireClubTimeZone } from "@/lib/club-time";
import { HELD_KEY_READ_SIZE, runBookingMoneyCensus, type BookingMoneyCensusDependencies } from "@/lib/cron-booking-money-census";

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

type MockedDependencies = {
  [K in keyof BookingMoneyCensusDependencies]: Mock<BookingMoneyCensusDependencies[K]>;
};

function buildDeps(overrides: Partial<MockedDependencies> = {}): MockedDependencies {
  return {
    readZone: vi.fn(async () => ZONE),
    readJournalInactive: vi.fn(async () => null),
    censusLedger: vi.fn(async () => cleanReport()),
    censusMoney: vi.fn(async () => moneyTotals()),
    findHeldKeys: vi.fn(async () => new Set<string>()),
    readClaimState: vi.fn(async () => "none" as const),
    // Like the real helper: claims, runs the send, and keeps the claim when someone was sent it.
    sendOnceEver: vi.fn(async ({ send }) => {
      await send();
      return true;
    }),
    sendAlert: vi.fn(async () => DELIVERED),
    stampSent: vi.fn(async () => undefined),
    now: vi.fn(() => NOW),
    ...overrides,
  };
}

/** The drift findings' keys: the known class `NOTHING_CAPTURED` is never emailed, so never stamped. */
const DRIFT_KEYS = [
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

  it("left to its own reads, runs both censuses on the database with no acknowledgements and the club's journal state", async () => {
    mocks.getClubFormat.mockResolvedValue({ currencyCode: "NZD", locale: "en-NZ", unusableStoredCurrency: "XAU" });
    mocks.censusBookingLedgerProjection.mockResolvedValue(cleanReport());
    mocks.censusBookingMoneyReconciliation.mockResolvedValue(moneyTotals());
    const { readJournalInactive, censusLedger, censusMoney, now, ...injected } = buildDeps();

    const summary = await runBookingMoneyCensus(injected);

    // No `acknowledgements`: the server holds no owner file, so every finding is reported.
    expect(mocks.censusBookingLedgerProjection).toHaveBeenCalledWith(mocks.prisma, {
      journalInactive: expect.stringContaining("XAU"),
      pageSize: CENSUS_PAGE_SIZE,
    });
    expect(mocks.censusBookingMoneyReconciliation).toHaveBeenCalledWith(mocks.prisma, ZONE);
    expect(summary).toMatchObject({ verdict: "GATE_OPEN", findings: 0 });
    for (const unused of [readJournalInactive, censusLedger, censusMoney, now]) expect(unused).not.toHaveBeenCalled();
  });

  it("alerts once for a night's new drift, names it by class and booking, stamps each, and leaves the known class out", async () => {
    const deps = buildDeps({ censusLedger: vi.fn(async () => driftReport()), censusMoney: vi.fn(async () => moneyTotals(2)) });

    const summary = await runBookingMoneyCensus(deps);

    expect(deps.sendOnceEver).toHaveBeenCalledTimes(1);
    expect(deps.sendOnceEver.mock.calls[0][0]).toMatchObject({ key: expect.stringMatching(/^booking-money-census:digest:[0-9a-f]{32}$/) });
    expect(deps.sendAlert).toHaveBeenCalledWith({
      newFindings: 3,
      classes: [
        { class: "disagreement:CAPTURED", group: "disagreement", count: 1, bookingIds: ["bk-captured"] },
        { class: "coverage:NO_LINES", group: "coverage", count: 1, bookingIds: ["bk-no-lines"] },
        { class: "integrity:SOURCE_DRIFT", group: "integrity", count: 1, bookingIds: ["bk-drift"] },
      ],
    });
    expect(deps.stampSent.mock.calls.map(([key]) => key)).toEqual(DRIFT_KEYS);
    expect(summary).toMatchObject({
      verdict: "GATE_CLOSED",
      bookingsChecked: 7,
      findings: 4,
      // The known class awaits the owner; it is not drift.
      drift: 3,
      unacknowledgedClassInstances: 1,
      reconciliation: { totalBookings: 7, reconciled: 5, unreconciled: 2, byReason: { HEADLINE_TOTAL_MISMATCH: 2 } },
      alert: { newFindings: 3, sent: true, failed: false },
    });
    // The known class is still in the summary, for the Stuck States info item.
    expect(summary.classes.map((entry) => entry.class)).toContain("class:NOTHING_CAPTURED");
  });

  it("stores a summary the dashboard's reader accepts after the JSON round trip the scheduler makes", async () => {
    const deps = buildDeps({ censusLedger: vi.fn(async () => driftReport()), censusMoney: vi.fn(async () => moneyTotals(2)) });

    const summary = await runBookingMoneyCensus(deps);

    expect(parseBookingMoneyCensusSummary(JSON.parse(JSON.stringify(summary)))).toEqual(summary);
  });

  it("leaves out a finding already alerted, and sends nothing once every drift finding was alerted", async () => {
    const heldOne = buildDeps({
      censusLedger: vi.fn(async () => driftReport()),
      findHeldKeys: vi.fn(async () => new Set(["booking-money-census:disagreement:CAPTURED:bk-captured"])),
    });

    const partly = await runBookingMoneyCensus(heldOne);

    expect(heldOne.sendAlert.mock.calls[0][0].classes.map((entry) => entry.class)).toEqual([
      "coverage:NO_LINES",
      "integrity:SOURCE_DRIFT",
    ]);
    expect(heldOne.stampSent.mock.calls.map(([key]) => key)).not.toContain("booking-money-census:disagreement:CAPTURED:bk-captured");
    // The summary still reports every finding; only the alert is once-only.
    expect(partly).toMatchObject({ findings: 4, alert: { newFindings: 2, sent: true } });

    const heldAll = buildDeps({
      censusLedger: vi.fn(async () => driftReport()),
      findHeldKeys: vi.fn(async (keys: readonly string[]) => new Set(keys)),
    });

    const quiet = await runBookingMoneyCensus(heldAll);

    expect(heldAll.sendOnceEver).not.toHaveBeenCalled();
    expect(heldAll.stampSent).not.toHaveBeenCalled();
    expect(quiet).toMatchObject({ findings: 4, alert: { newFindings: 0, sent: false, failed: false } });
  });

  it.each([
    ["the send failed and the claim was given back", "none"],
    ["no admin can receive it and the claim is held for a day", "deferred"],
  ] as const)("stamps nothing and warns on Background Jobs when %s", async (_case, claimState) => {
    const deps = buildDeps({
      censusLedger: vi.fn(async () => driftReport()),
      // The real helper never throws: a send that reached nobody is only a false.
      sendOnceEver: vi.fn(async () => false),
      readClaimState: vi.fn(async () => claimState),
    });

    const summary = await runBookingMoneyCensus(deps);

    // Nothing stamped, so a later night tries again.
    expect(deps.stampSent).not.toHaveBeenCalled();
    expect(summary.alert).toEqual({ newFindings: 3, sent: false, failed: true });
    expect(summary.warning).toContain("could not be sent");
    expect(summary).toMatchObject({ findings: 4, drift: 3 });
  });

  it("neither stamps nor warns while another instance is sending the same night's email", async () => {
    const deps = buildDeps({
      censusLedger: vi.fn(async () => driftReport()),
      sendOnceEver: vi.fn(async () => false),
      readClaimState: vi.fn(async () => "awaiting-send" as const),
    });

    const summary = await runBookingMoneyCensus(deps);

    expect(deps.stampSent).not.toHaveBeenCalled();
    expect(summary.alert).toEqual({ newFindings: 3, sent: false, failed: false });
    expect(summary.warning).toBeUndefined();
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
    expect(deps.stampSent.mock.calls.map(([key]) => key)).toEqual(DRIFT_KEYS);
    expect(summary.alert).toEqual({ newFindings: 3, sent: false, failed: false });
    expect(summary.warning).toBeUndefined();
  });

  it("sends no email on a night whose only findings are known classes, the first night included", async () => {
    const report = cleanReport();
    // Known classes that follow ordinary cancellations: never emailed (owner decision, 28 Nov 2026).
    report.classes.IN_FLIGHT_REFUND.instances.push({ bookingId: "bk-refund", identity: "CAPTURED", cents: 500, acknowledged: false });
    report.classes.IN_FLIGHT_HAND_BACK.instances.push({ bookingId: "bk-hand-back", identity: "CAPTURED", cents: 700, acknowledged: false });
    report.unacknowledgedClassInstances = 2;
    report.verdict = "GATE_CLOSED";
    const deps = buildDeps({ censusLedger: vi.fn(async () => report) });

    const summary = await runBookingMoneyCensus(deps);

    expect(deps.findHeldKeys).not.toHaveBeenCalled();
    expect(deps.sendOnceEver).not.toHaveBeenCalled();
    expect(deps.sendAlert).not.toHaveBeenCalled();
    expect(deps.stampSent).not.toHaveBeenCalled();
    // Still reported, for the Stuck States info item.
    expect(summary).toMatchObject({ findings: 2, drift: 0, unacknowledgedClassInstances: 2, alert: { newFindings: 0, sent: false, failed: false } });
    expect(summary.classes.map((entry) => entry.group)).toEqual(["class", "class"]);
  });

  it("asks the alert store in chunks of HELD_KEY_READ_SIZE and drops a held key from either side of a chunk edge", async () => {
    const report = cleanReport();
    const total = HELD_KEY_READ_SIZE + 1;
    for (let index = 0; index < total; index += 1) report.coverage.UNPOSTED_EDIT.push(`bk-${String(index).padStart(4, "0")}`);
    report.verdict = "GATE_CLOSED";
    const keyOf = (index: number) => `booking-money-census:coverage:UNPOSTED_EDIT:bk-${String(index).padStart(4, "0")}`;
    // Held: the last key of the first chunk and the only key of the second.
    const held = new Set([keyOf(HELD_KEY_READ_SIZE - 1), keyOf(HELD_KEY_READ_SIZE)]);
    const deps = buildDeps({
      censusLedger: vi.fn(async () => report),
      findHeldKeys: vi.fn(async (keys: readonly string[]) => new Set(keys.filter((key) => held.has(key)))),
    });

    const summary = await runBookingMoneyCensus(deps);

    expect(deps.findHeldKeys.mock.calls.map(([keys]) => keys.length)).toEqual([HELD_KEY_READ_SIZE, 1]);
    expect(deps.findHeldKeys.mock.calls.flatMap(([keys]) => keys)).toEqual(Array.from({ length: total }, (_, index) => keyOf(index)));
    expect(summary.alert).toEqual({ newFindings: total - 2, sent: true, failed: false });
    expect(deps.stampSent).toHaveBeenCalledTimes(total - 2);
    const stamped = new Set(deps.stampSent.mock.calls.map(([key]) => key));
    for (const key of held) expect(stamped.has(key)).toBe(false);
  });

  it("turns a closed gate with no other finding into drift that carries the census's reasons", async () => {
    const report = cleanReport();
    report.verdict = "GATE_CLOSED";
    report.gateClosedBecause = ["2 stale acknowledgement(s): the figure moved since it was signed off"];
    const deps = buildDeps({ censusLedger: vi.fn(async () => report) });

    const summary = await runBookingMoneyCensus(deps);

    expect(summary).toMatchObject({ verdict: "GATE_CLOSED", findings: 1, drift: 1 });
    expect(summary.classes).toEqual([
      { class: "gate:2 stale acknowledgement(s): the figure moved since it was signed off", group: "gate", count: 1, bookingIds: [] },
    ]);
    expect(deps.sendAlert).toHaveBeenCalledTimes(1);
    expect(parseBookingMoneyCensusSummary(JSON.parse(JSON.stringify(summary)))).toEqual(summary);
  });

  it("finds nothing exactly when the census's verdict is open: a finding never stands beside an open gate, nor a gate reason beside a finding", () => {
    expect(listBookingMoneyCensusFindings(cleanReport())).toEqual([]);
    const withDrift = driftReport();
    withDrift.gateClosedBecause = ["1 unclassified disagreement(s)"];
    expect(listBookingMoneyCensusFindings(withDrift).map((finding) => finding.group)).not.toContain("gate");
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
    // The warning is what admin cron health reads to show the run as not healthy.
    expect(summary.warning).toContain("could not be sent");
    expect(parseBookingMoneyCensusSummary(JSON.parse(JSON.stringify(summary)))).toEqual(summary);
    expect(deps.sendOnceEver).not.toHaveBeenCalled();
    expect(mocks.reportCronError).toHaveBeenCalledTimes(1);
  });
});
