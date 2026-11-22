/**
 * #5185 (Ledger M4d): the five hand-back classes (`classifyHandBacks`) and comparison report v3
 * (`JOURNAL_REFUND_PAYABLE`), judged from the facts the census reads. Pure. The same over real door postings on
 * PostgreSQL is in `member-money-hand-backs.realdb.test.ts` and `booking-ledger-projection-census.realdb.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { journalRefundPayableComparison, withJournalChargeComparison } from "@/lib/booking-ledger-projection-census-journal";
import type { BookingLedgerEvaluation } from "@/lib/booking-ledger-projection-census";
import type { BookingLedgerCensusRow } from "@/lib/booking-ledger-projection-census-row";
import { classifyHandBacks, HAND_BACK_CENSUS_CLASSES, type BookingHandBackJournal, type HandBackCensusClass } from "@/lib/member-money";

const B = "census-5185";
const ERA = new Date("2026-06-15T00:00:00.000Z");
const BEFORE = new Date("2026-06-01T00:00:00.000Z");
const AFTER = new Date("2026-06-20T00:00:00.000Z");

type Task = BookingHandBackJournal["tasks"][number];
function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id, kind: "CANCELLED_BOOKING_HAND_BACK", status: "OPEN", amountCents: 8_000, paymentId: `${B}-payment`, occurrenceKey: null,
    partPaymentReviewPaymentId: null, reason: `Booking ${B} cancelled, refund by hand.`, lateCaptureApprovalIntentId: null,
    createdAt: AFTER, completedAt: null, ...overrides,
  };
}
const paidTask = (id: string, overrides: Partial<Task> = {}) => task(id, { status: "COMPLETED", completedAt: AFTER, ...overrides });
const lateCapture = (id: string, intent: string, overrides: Partial<Task> = {}) =>
  task(id, { kind: "DELETED_BOOKING_LATE_CAPTURE", lateCaptureApprovalIntentId: intent, status: "DISMISSED", completedAt: AFTER, amountCents: 2_500, ...overrides });

function facts(overrides: Partial<BookingHandBackJournal> = {}): BookingHandBackJournal {
  return { handBackSince: ERA, tasks: [], debts: new Map(), payments: new Map(), keeps: new Map(), openRefundPayableCents: 0, journalCardRefundKeys: new Set(),
    captureReturnDebts: new Set(), captureReturnsWithRow: new Set(), ...overrides };
}
const kinds = (input: BookingHandBackJournal) => classifyHandBacks(B, input).map((finding) => `${finding.kind} ${finding.identity}`);

describe("the hand-back classes (#5185)", () => {
  it("a consistent booking reports none: raised, paid, withdrawn on dismissal, reduced by a lost dispute, and kept", () => {
    expect(kinds(facts({
      tasks: [
        task("open"),
        paidTask("paid"),
        task("check", { status: "DISMISSED", completedAt: AFTER, occurrenceKey: null }),
        task("reduced", { amountCents: 6_000 }),
        lateCapture("kept", "pi_kept"),
      ],
      debts: new Map([["open", 8_000], ["paid", 0], ["check", 0], ["reduced", 6_000]]),
      payments: new Map([["paid", { applied: true }]]),
      keeps: new Map([["pi_kept", true]]),
    }))).toEqual([]);
  });

  it("does not list history from before the hand-back era: raised, paid unapplied or kept before it, as designed", () => {
    expect(kinds(facts({
      tasks: [task("old-open", { createdAt: BEFORE }), paidTask("old-paid", { createdAt: BEFORE, completedAt: BEFORE }),
        paidTask("old-raised-paid-now", { createdAt: BEFORE }), lateCapture("old-keep", "pi_old", { completedAt: BEFORE })],
      // A task raised before the era and paid in it posts its R14 unapplied: the designed path, not a finding.
      payments: new Map([["old-raised-paid-now", { applied: false }]]),
      keeps: new Map([["pi_old", false]]),
    }))).toEqual([]);
    // Before the journal's first M4d event there is no era at all.
    expect(kinds(facts({ handBackSince: null, tasks: [task("t")], keeps: new Map([["pi", false]]) }))).toEqual([]);
  });

  it("HAND_BACK_WITHOUT_EVENT: a journal hand-back raised in the era with no R05; not a task the journal does not record", () => {
    expect(kinds(facts({ tasks: [task("skipped"), task("review", { kind: "EDIT_FINANCIAL_REVIEW" }), task("no-payment", { paymentId: null })] })))
      .toEqual(["HAND_BACK_WITHOUT_EVENT skipped"]);
  });

  it("HAND_BACK_PAID_WITHOUT_EVENT: completed in the era with no live R14", () => {
    expect(kinds(facts({ tasks: [paidTask("unpaid")], debts: new Map([["unpaid", 0]]) }))).toEqual(["HAND_BACK_PAID_WITHOUT_EVENT unpaid"]);
  });

  it("UNAPPLIED_HAND_BACK: an R14 that paid no debt for a task whose debt is the journal's, or raised in the era", () => {
    expect(kinds(facts({
      tasks: [paidTask("held"), paidTask("era")],
      debts: new Map([["held", 0]]),
      payments: new Map([["held", { applied: false }], ["era", { applied: false }]]),
    }))).toEqual(["UNAPPLIED_HAND_BACK held", "HAND_BACK_WITHOUT_EVENT era", "UNAPPLIED_HAND_BACK era"]);
  });

  it("HAND_BACK_OBLIGATION_DRIFT: a debt open while its task is closed, or the reverse, or a task's amount moved without its debt", () => {
    const found = classifyHandBacks(B, facts({
      tasks: [paidTask("closed"), task("withdrawn"), task("moved", { amountCents: 5_000 })],
      debts: new Map([["closed", 8_000], ["withdrawn", 0], ["moved", 8_000]]),
      payments: new Map([["closed", { applied: true }]]),
    }));
    expect(found.map((finding) => [finding.kind, finding.identity, finding.cents])).toEqual([
      ["HAND_BACK_OBLIGATION_DRIFT", "closed", 8_000],
      ["HAND_BACK_OBLIGATION_DRIFT", "withdrawn", -8_000],
      ["HAND_BACK_OBLIGATION_DRIFT", "moved", 3_000],
    ]);
  });

  it("HAND_BACK_OBLIGATION_DRIFT: an open hand-back debt whose task row is gone (#5212), or is no journal hand-back; a withdrawn one is not", () => {
    expect(kinds(facts({
      tasks: [task("review", { kind: "EDIT_FINANCIAL_REVIEW" })],
      debts: new Map([["deleted", 8_000], ["review", 1_000], ["withdrawn-deleted", 0]]),
    }))).toEqual(["HAND_BACK_OBLIGATION_DRIFT deleted", "HAND_BACK_OBLIGATION_DRIFT review"]);
  });

  it("KEEP_WITHOUT_EVENT: a late capture kept in the era whose capture holds money, with no live keep", () => {
    expect(kinds(facts({
      tasks: [lateCapture("lost", "pi_lost"), lateCapture("held", "pi_held"), lateCapture("empty", "pi_empty")],
      // `keeps` names only captures that hold money: an empty one posts no keep.
      keeps: new Map([["pi_lost", false], ["pi_held", true]]),
    }))).toEqual(["KEEP_WITHOUT_EVENT lost"]);
  });
});

/** One seeded bad booking per class: a sixth class without a case here fails the `it.each` below. */
const SEEDED: Record<HandBackCensusClass, BookingHandBackJournal> = {
  HAND_BACK_WITHOUT_EVENT: facts({ tasks: [task("bad")] }),
  HAND_BACK_PAID_WITHOUT_EVENT: facts({ tasks: [paidTask("bad")], debts: new Map([["bad", 0]]) }),
  UNAPPLIED_HAND_BACK: facts({ tasks: [paidTask("bad")], debts: new Map([["bad", 0]]), payments: new Map([["bad", { applied: false }]]) }),
  HAND_BACK_OBLIGATION_DRIFT: facts({ tasks: [paidTask("bad")], debts: new Map([["bad", 8_000]]), payments: new Map([["bad", { applied: true }]]) }),
  KEEP_WITHOUT_EVENT: facts({ tasks: [lateCapture("bad", "pi_bad")], keeps: new Map([["pi_bad", false]]) }),
};

describe("every hand-back class is reported for a seeded bad row (#5185)", () => {
  it("covers exactly the classes the census defines", () => {
    expect(Object.keys(SEEDED).sort()).toEqual([...HAND_BACK_CENSUS_CLASSES].sort());
  });

  it.each(HAND_BACK_CENSUS_CLASSES)("%s alone", (kind) => {
    const seeded = SEEDED[kind];
    expect(seeded, `no seeded bad row for ${kind}`).toBeDefined();
    expect(kinds(seeded)).toEqual([`${kind} bad`]);
  });
});

function row(handBacks: BookingHandBackJournal | null, overrides: Partial<BookingLedgerCensusRow> = {}): BookingLedgerCensusRow {
  return {
    booking: { id: B, status: "CANCELLED", deletedAt: null, organiserSettled: false, finalPriceCents: 0 },
    payment: null, transactions: [], refunds: [], credits: [], tasks: [], modifications: [], recoveryOperations: [],
    cancellation: null, appeals: [], groupSettlement: null, groupChild: null, lines: [],
    journal: { charged: true, components: [], bridgedLineIds: new Set(), journalSince: null }, handBacks, ...overrides,
  };
}
type Operation = BookingLedgerCensusRow["recoveryOperations"][number];
const cardRefund = (key: string, overrides: Partial<Operation> = {}): Operation => ({
  type: "REFUND_BOOKING_MODIFICATION", status: "PENDING", attempts: 0, nextRetryAt: null, amountCents: 4_000, idempotencyKey: key,
  paymentId: `${B}-payment`, paymentIntentId: "pi_card", ...overrides,
});

describe("comparison report v3: JOURNAL_REFUND_PAYABLE (#5185)", () => {
  it("is not judged for a booking whose R01 is not in the journal, or read without hand-back facts (the back-post's own judgement)", () => {
    expect(journalRefundPayableComparison(row(facts(), { journal: { charged: false, components: [], bridgedLineIds: new Set(), journalSince: null } })).identity.status).toBe("NOT_APPLICABLE");
    expect(journalRefundPayableComparison(row(null)).identity.status).toBe("NOT_APPLICABLE");
  });

  it("agrees when the open refund payable is the held hand-backs' owed cents plus the open card refunds' unmade slices", () => {
    const result = journalRefundPayableComparison(row(facts({
      tasks: [task("open"), task("reduced", { amountCents: 6_000 }), paidTask("paid"), task("pre-era", { createdAt: BEFORE })],
      debts: new Map([["open", 8_000], ["reduced", 6_000], ["paid", 0]]),
      payments: new Map([["paid", { applied: true }]]),
      openRefundPayableCents: 8_000 + 6_000 + 3_000,
      journalCardRefundKeys: new Set(["held"]),
    }), {
      recoveryOperations: [
        // A dead row still owes until closed: 3_000 of its 4_000 not yet made.
        cardRefund("held", { status: "FAILED", attempts: 9, allocationPlan: [{ paymentTransactionId: "t1", amountCents: 1_000, madeRefundId: "re_1" }, { paymentTransactionId: "t2", amountCents: 3_000 }] }),
        // A debt raised before its door posted R05s is not the journal's: not counted.
        cardRefund("pre-m4c"),
        cardRefund("done", { status: "SUCCEEDED" }),
      ],
    }));
    expect(result.identity).toMatchObject({ identity: "JOURNAL_REFUND_PAYABLE", status: "AGREE", columnCents: 17_000, ledgerCents: 17_000 });
    expect(result.integrity).toEqual([]);
  });

  it("a late capture whose automatic refund Stripe refused agrees while held, once approved, and once kept (review fix 1)", () => {
    // Held: the refund reserved its slice, so the capture-return R05 posted; Stripe refused, and the task holds it.
    const held = facts({ tasks: [lateCapture("t", "pi_late", { status: "OPEN", completedAt: null })], captureReturnDebts: new Set(["pi_late"]), openRefundPayableCents: 2_500 });
    expect(journalRefundPayableComparison(row(held)).identity).toMatchObject({ status: "AGREE", columnCents: 2_500, ledgerCents: 2_500 });
    // A failed refund's row on the same debt is counted once: the row, not the task too.
    const failed = cardRefund("failed-later", { status: "FAILED", amountCents: 2_500, paymentIntentId: "pi_late" });
    expect(journalRefundPayableComparison(row({ ...held, journalCardRefundKeys: new Set(["failed-later"]), captureReturnsWithRow: new Set(["pi_late"]) },
      { recoveryOperations: [failed] })).identity).toMatchObject({ status: "AGREE", ledgerCents: 2_500 });
    // Approved: the task is completed and the approval's row owes the slice.
    const approved = facts({ tasks: [lateCapture("t", "pi_late", { status: "COMPLETED" })], captureReturnDebts: new Set(["pi_late"]),
      journalCardRefundKeys: new Set(["approval"]), captureReturnsWithRow: new Set(["pi_late"]), openRefundPayableCents: 2_500 });
    expect(journalRefundPayableComparison(row(approved, { recoveryOperations: [cardRefund("approval", { amountCents: 2_500, paymentIntentId: "pi_late" })] })).identity)
      .toMatchObject({ status: "AGREE", ledgerCents: 2_500 });
    // Kept: the debt is reversed, so the reader keys no row on it (it is not live) and the dismissed task owes nothing.
    const kept = facts({ tasks: [lateCapture("t", "pi_late")], captureReturnDebts: new Set(["pi_late"]), keeps: new Map([["pi_late", true]]) });
    expect(journalRefundPayableComparison(row(kept, { recoveryOperations: [failed] })).identity).toMatchObject({ status: "AGREE", columnCents: 0, ledgerCents: 0 });
    // A held capture the journal never took on (approval required, no automatic refund tried) is not counted.
    expect(journalRefundPayableComparison(row(facts({ tasks: [lateCapture("t", "pi_late", { status: "OPEN", completedAt: null })] }))).identity)
      .toMatchObject({ status: "AGREE", ledgerCents: 0 });
  });

  it("(acknowledged difference) a late capture kept while its capture-return debt is part paid disagrees by the debt's open cents", () => {
    // `closeKeptCaptureReturn` leaves a part-paid debt open on purpose; the task is dismissed and the refused refund left no row.
    const kept = facts({ tasks: [lateCapture("t", "pi_late")], captureReturnDebts: new Set(["pi_late"]), keeps: new Map([["pi_late", true]]),
      openRefundPayableCents: 1_500 });
    const result = journalRefundPayableComparison(row(kept));
    expect(result.identity).toMatchObject({ status: "DISAGREE", columnCents: 1_500, ledgerCents: 0, deltaCents: 1_500 });
    expect(result.integrity).toEqual([]);
  });

  it("disagrees on a debt with nothing behind it: a card refund made without paying its debt, or a hand-back whose task is gone", () => {
    const made = journalRefundPayableComparison(row(facts({ openRefundPayableCents: 4_000, journalCardRefundKeys: new Set() }), {
      recoveryOperations: [cardRefund("made", { status: "SUCCEEDED" })],
    }));
    expect(made.identity).toMatchObject({ status: "DISAGREE", columnCents: 4_000, ledgerCents: 0, deltaCents: 4_000 });
    const orphan = journalRefundPayableComparison(row(facts({ debts: new Map([["gone", 8_000]]), openRefundPayableCents: 8_000 })));
    expect(orphan.identity).toMatchObject({ status: "DISAGREE", columnCents: 8_000, ledgerCents: 0 });
    expect(orphan.integrity).toEqual([expect.objectContaining({ bookingId: B, lineId: "gone", kind: "HAND_BACK_OBLIGATION_DRIFT" })]);
  });

  it("adds v3 and the hand-back classes beside the charge identity, each finding naming its task", () => {
    const evaluation: BookingLedgerEvaluation = { bookingId: B, lineCount: 0, identities: [], coverage: [], bookingClass: null, bookingInstances: [], integrity: [],
      info: { unkeyedLines: 0, retainedCollectedCents: 0, ibUnallocatedAppliedCredit: null, groupSettlementUnpostable: null } };
    const judged = withJournalChargeComparison(evaluation, row(facts({ tasks: [task("skipped")] })));
    expect(judged.identities.map((identity) => identity.identity)).toEqual(["JOURNAL", "JOURNAL_REFUND_PAYABLE"]);
    expect(judged.integrity).toEqual([expect.objectContaining({ lineId: "skipped", kind: "HAND_BACK_WITHOUT_EVENT" })]);
  });
});
