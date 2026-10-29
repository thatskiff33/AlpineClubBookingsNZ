/**
 * #4312 round 7 (#4104, `INV-ADDPAY-047`): which refunds Stripe failed later a
 * card refund was sent again for (`readFailedRefundsAnsweredBy`) - by the
 * replay's own record alone: the slice it sent for them (a row of its own's
 * key, a re-planned slice's `failedRefundIds`), marked with the refund Stripe
 * made (`madeRefundId`), a failed re-send's chain included - and what their own
 * notes cover. A refund no slice is marked with answers nothing, whatever its
 * charge, amount or time. Each case also checks Xero's total against what went
 * back (`xeroCoverAfterAsking`). The real PostgreSQL proofs of each writer are
 * `xero-bt-card-refund-notes.realdb.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const lateCaptures = vi.hoisted(() => new Set<string>());
const coverByRefund = vi.hoisted(() => new Map<string, number>());
const log = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));

vi.mock("@/lib/logger", () => ({ default: log }));

vi.mock("@/lib/late-capture-xero-receipt", () => ({
  findLateCapturePaymentIntents: async (ids: readonly string[]) => new Set(ids.filter((id) => lateCaptures.has(id))),
}));
vi.mock("@/lib/xero-resolved-in-xero-fences", () => ({
  sumRefundCreditNoteCoverageOfRowsCents: async (_paymentId: string, where: { OR: Array<{ requestPayload?: { equals: string } }> }) =>
    coverByRefund.get(where.OR[0]!.requestPayload!.equals) ?? 0,
}));

import { refundSliceStripeIdempotencyKey } from "@/lib/payment-recovery-keys";
import { REFUND_SLICE_KEY_METADATA } from "@/lib/refund-slice-evidence";
import { pairResendRecordedFirst, readFailedRefundsAnsweredBy, unmarkedResendSlicesFor, type ResendRow } from "@/lib/card-refund-resend-answer";

const PAYMENT = "payment-1";
const TXN = "txn-card";

/** Who made a refund: the recovery replay (`replay`), or the treasurer in the Stripe dashboard (`dashboard`). */
type Refund = { stripeRefundId: string; amountCents: number; status: string; stripePaymentIntentId: string | null; door: "replay" | "dashboard" };
type Row = { idempotencyKey: string; allocationPlan: unknown };

let refunds: Refund[];
let rows: Row[];
let noteRows: Set<string>;

function refund(id: string, status = "succeeded", door: Refund["door"] = "replay", amountCents = 4_000): Refund {
  return { stripeRefundId: id, amountCents, status, stripePaymentIntentId: "pi_card", door };
}

/** A card refund row with one $40 slice on the card charge. */
function row(idempotencyKey: string, slice: Record<string, unknown> = {}): Row {
  return { idempotencyKey, allocationPlan: [{ paymentTransactionId: TXN, amountCents: 4_000, ...slice }] };
}

/** A failed refund noted on its own record for `cents`. */
function noted(id: string, cents = 4_000) {
  noteRows.add(id);
  coverByRefund.set(id, cents);
}

const db = {
  paymentRefund: {
    findFirst: async ({ where }: { where: { stripeRefundId: string } }) => refunds.find((each) => each.stripeRefundId === where.stripeRefundId) ?? null,
  },
  paymentRecoveryOperation: { findMany: async () => rows },
  manualRefundTask: {},
  xeroSyncOperation: { count: async ({ where }: { where: { OR: Array<{ requestPayload?: { equals: string } }> } }) => (noteRows.has(where.OR[0]!.requestPayload!.equals) ? 1 : 0) },
  xeroObjectLink: {},
} as never;

const answered = (id: string) => readFailedRefundsAnsweredBy(db, PAYMENT, id);

/**
 * What Xero holds once every writer has asked: the failed refunds' own notes (`coverByRefund`), each dashboard
 * refund's own note in full, each re-send's own note where it answers an own-noted failure, at its amount less what
 * they cover (`readCardRefundNoteShare`), and `canonicalCents` for what the canonical note answers.
 */
async function xeroCoverAfterAsking(canonicalCents = 0): Promise<number> {
  let cents = canonicalCents + [...coverByRefund.values()].reduce((sum, each) => sum + each, 0);
  for (const each of refunds.filter((refund) => refund.status === "succeeded")) {
    if (each.door === "dashboard") {
      cents += each.amountCents;
      continue;
    }
    const answer = await answered(each.stripeRefundId);
    if (answer.ownNoted) cents += Math.max(0, each.amountCents - answer.coverCents);
  }
  return cents;
}

const refundedCents = () => refunds.filter((refund) => refund.status === "succeeded").reduce((sum, refund) => sum + refund.amountCents, 0);

beforeEach(() => {
  lateCaptures.clear();
  coverByRefund.clear();
  noteRows = new Set();
  noted("re_failed");
  refunds = [refund("re_failed", "failed")];
  rows = [row("card_refund_failed_later_re_failed")];
});

describe("a card refund sent again for one Stripe failed later is paired by the replay's record (#4312 round 7)", () => {
  it("MUTATION: the refund its row's slice is marked with answers the failure, with the failed refund's own note; no other refund does", async () => {
    rows = [row("card_refund_failed_later_re_failed", { madeRefundId: "re_resent" })];
    refunds.push(refund("re_resent"), refund("re_same_amount_dashboard", "succeeded", "dashboard"), refund("re_other_amount", "succeeded", "dashboard", 1_000));
    expect(await answered("re_resent")).toEqual({ failedRefundIds: ["re_failed"], ownNoted: true, coverCents: 4_000 });
    for (const id of ["re_same_amount_dashboard", "re_other_amount"]) expect(await answered(id)).toEqual({ failedRefundIds: [], ownNoted: false, coverCents: 0 });
    expect(await xeroCoverAfterAsking()).toBe(refundedCents());
  });

  it("MUTATION (finding 1): a dashboard refund made before the replay never takes the re-send's place - $80 in Xero for $80 refunded", async () => {
    // The treasurer refunds $40 in the dashboard while the row of its own still waits; then the replay sends its slice.
    refunds.push(refund("re_dashboard", "succeeded", "dashboard"));
    expect((await answered("re_dashboard")).failedRefundIds).toEqual([]);
    rows = [row("card_refund_failed_later_re_failed", { madeRefundId: "re_resent" })];
    refunds.push(refund("re_resent"));
    expect(await answered("re_resent")).toEqual({ failedRefundIds: ["re_failed"], ownNoted: true, coverCents: 4_000 });
    expect(await xeroCoverAfterAsking()).toBe(8_000);
    expect(refundedCents()).toBe(8_000);
  });

  it("before the replay marks its slice, its refund answers nothing; once marked, it answers - whoever recorded it first", async () => {
    refunds.push(refund("re_resent"));
    expect((await answered("re_resent")).failedRefundIds).toEqual([]);
    rows = [row("card_refund_failed_later_re_failed", { madeRefundId: "re_resent" })];
    expect((await answered("re_resent")).failedRefundIds).toEqual(["re_failed"]);
  });

  it("MUTATION: two failures on one charge for one amount: each re-send answers the failure its own slice was sent for", async () => {
    noted("re_failed_2");
    refunds.push(refund("re_failed_2", "failed"), refund("re_resent_2"), refund("re_resent"));
    rows = [
      row("card_refund_failed_later_re_failed", { madeRefundId: "re_resent" }),
      row("card_refund_failed_later_re_failed_2", { madeRefundId: "re_resent_2" }),
    ];
    expect((await answered("re_resent")).failedRefundIds).toEqual(["re_failed"]);
    expect((await answered("re_resent_2")).failedRefundIds).toEqual(["re_failed_2"]);
    expect(await xeroCoverAfterAsking()).toBe(refundedCents());
  });

  it("MUTATION: a re-planned slice's failures - every one of them - are answered by the refund it is marked with", async () => {
    rows = [row("refund_request_refund_request-1", { stripeKeySuffix: "refused2", failedRefundIds: ["re_failed", "re_failed_again"], madeRefundId: "re_resent" })];
    refunds.push(refund("re_failed_again", "failed"), refund("re_resent"));
    expect(await answered("re_resent")).toEqual({ failedRefundIds: ["re_failed", "re_failed_again"], ownNoted: true, coverCents: 4_000 });
    expect(await xeroCoverAfterAsking()).toBe(refundedCents());
  });

  it("MUTATION (chain of three): a re-send Stripe failed too passes on what it answered, through the slice marked with it", async () => {
    // F0 is noted at $40. The request's row re-planned it and sent R1 (marked) and closed; Stripe failed R1, so a row of
    // its own sent R2 (marked) and closed; Stripe failed R2 too, and a row of its own sent R3.
    noteRows.clear();
    coverByRefund.clear();
    noted("re_f0");
    refunds = [refund("re_f0", "failed"), refund("re_r1", "failed"), refund("re_r2", "failed"), refund("re_r3")];
    rows = [
      row("refund_request_refund_request-1", { stripeKeySuffix: "refused1", failedRefundIds: ["re_f0"], madeRefundId: "re_r1" }),
      row("card_refund_failed_later_re_r1", { madeRefundId: "re_r2" }),
      row("card_refund_failed_later_re_r2", { madeRefundId: "re_r3" }),
    ];
    expect(await answered("re_r3")).toEqual({ failedRefundIds: ["re_r2", "re_r1", "re_f0"], ownNoted: true, coverCents: 4_000 });
    // R1 and R2 took no note (each answered by F0's), so Xero holds F0's $40 and nothing more: what went back.
    expect(await xeroCoverAfterAsking()).toBe(4_000);
    expect(refundedCents()).toBe(4_000);
  });

  it("MUTATION (finding 3): each failure's cover is counted for one refund only, however the chains meet", async () => {
    // Probe: a row of its own sent Z (marked) for F and closed; a dashboard refund X; Stripe failed Z, and a row of its
    // own owes Z, raised dead; a dashboard refund Y. Neither dashboard refund answers F, and Z no longer counts.
    refunds = [refund("re_failed", "failed"), refund("re_z", "failed"), refund("re_x", "succeeded", "dashboard"), refund("re_y", "succeeded", "dashboard")];
    rows = [row("card_refund_failed_later_re_failed", { madeRefundId: "re_z" }), row("card_refund_failed_later_re_z")];
    const answers = await Promise.all(refunds.map((each) => answered(each.stripeRefundId)));
    expect(answers.map((each) => each.coverCents)).toEqual([0, 0, 0, 0]);
    // And where both rows sent again, each failure is reached through one refund only.
    rows = [row("card_refund_failed_later_re_failed", { madeRefundId: "re_z" }), row("card_refund_failed_later_re_z", { madeRefundId: "re_w" })];
    refunds.push(refund("re_w"));
    const chains = await Promise.all(refunds.filter((each) => each.status === "succeeded").map((each) => answered(each.stripeRefundId)));
    const reached = chains.flatMap((each) => each.failedRefundIds);
    expect(reached.sort()).toEqual(["re_failed", "re_z"]);
    expect(chains.reduce((sum, each) => sum + each.coverCents, 0)).toBe(4_000);
  });

  it("MUTATION (lens probe): an open row's re-planned slice marked with its third send answers both failures; another row's unmarked slice answers nothing", async () => {
    noteRows.clear();
    coverByRefund.clear();
    noted("re_f1");
    noted("re_f9");
    refunds = [refund("re_f9", "failed"), refund("re_f1", "failed"), refund("re_f2", "failed"), refund("re_r3"), refund("re_r9")];
    rows = [
      row("refund_request_refund_request-A", { stripeKeySuffix: "refused2", failedRefundIds: ["re_f1", "re_f2"], madeRefundId: "re_r3" }),
      row("refund_request_refund_request-C", { stripeKeySuffix: "refused1", failedRefundIds: ["re_f9"] }),
    ];
    expect((await answered("re_r3")).failedRefundIds).toEqual(["re_f1", "re_f2"]);
    expect((await answered("re_r9")).failedRefundIds).toEqual([]);
  });

  it("STATED LIMIT: a dashboard refund is never paired, even one settling a row raised dead - the replay's record is the only link", async () => {
    refunds = [refund("re_failed", "failed"), refund("re_dashboard", "succeeded", "dashboard")];
    rows = [row("card_refund_failed_later_re_failed")];
    expect(await answered("re_dashboard")).toEqual({ failedRefundIds: [], ownNoted: false, coverCents: 0 });
  });

  it("a slice made with no failure behind it - an inline refund, say - answers nothing", async () => {
    rows = [row("refund_request_refund_request-1", { madeRefundId: "re_inline" })];
    refunds.push(refund("re_inline"));
    expect((await answered("re_inline")).failedRefundIds).toEqual([]);
  });

  it("MUTATION: a failure with no note of its own is answered but not own-noted, and covers nothing", async () => {
    noteRows.clear();
    coverByRefund.clear();
    rows = [row("card_refund_failed_later_re_failed", { madeRefundId: "re_resent" })];
    refunds.push(refund("re_resent"));
    expect(await answered("re_resent")).toEqual({ failedRefundIds: ["re_failed"], ownNoted: false, coverCents: 0 });
    // Its failure folded into the canonical note, which answers it: $40 for $40.
    expect(await xeroCoverAfterAsking(4_000)).toBe(refundedCents());
  });

  it("MUTATION: a late capture's refund is its capture note's to size, and a refund no longer counted answers nothing", async () => {
    rows = [row("card_refund_failed_later_re_failed", { madeRefundId: "re_resent" })];
    refunds.push(refund("re_resent"));
    lateCaptures.add("pi_card");
    expect((await answered("re_resent")).failedRefundIds).toEqual([]);
    lateCaptures.clear();
    refunds[1] = refund("re_resent", "failed");
    expect((await answered("re_resent")).failedRefundIds).toEqual([]);
  });
});

// #4312 round 8 (F1, F2): a re-send `charge.refunded` records before its slice is marked is known by the unmarked
// re-send it could answer - its row's runner metadata, that slice's charge and amount, made after the row was raised.
describe("a re-send charge.refunded records before its slice is marked (#4312 round 8)", () => {
  const RAISED = new Date("2026-07-01T00:00:00.000Z");
  const MADE = new Date("2026-07-02T00:00:00.000Z");
  const DUPLICATE_PREFIX = "duplicate_capture_refund_booking-1_pi_dup";
  const runnerMetadata = { bookingId: "booking-1", reason: "duplicate_capture" };
  /** A duplicate capture's row whose $40 slice was re-planned for `re_failed`; `dead` when its retries are spent. */
  const resendRow = (id: string, { dead = false, slice = {} as Record<string, unknown>, status = dead ? "FAILED" : "PENDING" }: { dead?: boolean; slice?: Record<string, unknown>; status?: string } = {}): ResendRow => ({
    id, type: "REFUND_BOOKING_MODIFICATION", status, attempts: dead ? 5 : 1, idempotencyKey: `payment_recovery_modification_refund_${id}`,
    stripeKeyPrefix: DUPLICATE_PREFIX, bookingId: "booking-1", createdAt: RAISED, succeededAt: null,
    allocationPlan: [{ paymentTransactionId: TXN, amountCents: 4_000, stripeKeySuffix: "refused1", failedRefundIds: ["re_failed"], ...slice }],
  });
  const recorded = { stripeRefundId: "re_s", paymentTransactionId: TXN, amountCents: 4_000, createdAt: MADE, stripeCreatedAt: MADE, metadata: runnerMetadata };

  it("MUTATION: only an unmarked re-send of a row whose runner sent exactly this metadata, on its charge, for its amount, raised before it", () => {
    const row1 = resendRow("row-1");
    expect(unmarkedResendSlicesFor([row1], recorded)).toEqual([{ operation: row1, sliceIndex: 0 }]);
    // A Stripe dashboard refund, or another door's, carries other metadata.
    expect(unmarkedResendSlicesFor([row1], { ...recorded, metadata: {} })).toEqual([]);
    expect(unmarkedResendSlicesFor([row1], { ...recorded, metadata: { ...runnerMetadata, reason: "date_change_price_decrease" } })).toEqual([]);
    expect(unmarkedResendSlicesFor([row1], { ...recorded, metadata: { ...runnerMetadata, extra: "x" } })).toEqual([]);
    expect(unmarkedResendSlicesFor([row1], { ...recorded, paymentTransactionId: "txn-other" })).toEqual([]);
    expect(unmarkedResendSlicesFor([row1], { ...recorded, amountCents: 3_999 })).toEqual([]);
    expect(unmarkedResendSlicesFor([resendRow("row-1", { slice: { madeRefundId: "re_other" } })], recorded)).toEqual([]);
    expect(unmarkedResendSlicesFor([resendRow("row-1", { slice: { failedRefundIds: undefined } })], recorded)).toEqual([]);
    expect(unmarkedResendSlicesFor([resendRow("row-1", { status: "SUCCEEDED" })], recorded)).toEqual([]);
    // A row raised dead was never claimed, so it sent nothing.
    expect(unmarkedResendSlicesFor([resendRow("row-1", { dead: true, status: "PENDING" })], recorded)).toEqual([]);
    expect(unmarkedResendSlicesFor([{ ...row1, createdAt: new Date(MADE.getTime() + 1_000) }], recorded)).toEqual([]);
  });

  it("recognises keyed resend metadata while rejecting unrelated extra fields (#4510)", () => {
    const operation = resendRow("row-1");
    const metadata = { ...runnerMetadata, [REFUND_SLICE_KEY_METADATA]: refundSliceStripeIdempotencyKey(DUPLICATE_PREFIX, { paymentTransactionId: TXN, amountCents: 4_000, stripeKeySuffix: "refused1" }) };
    expect(unmarkedResendSlicesFor([operation], { ...recorded, metadata })).toEqual([{ operation, sliceIndex: 0 }]);
    expect(unmarkedResendSlicesFor([operation], { ...recorded, metadata: { ...metadata, extra: "x" } })).toEqual([]);
  });

  /** `written`: what each write matches in turn (the last repeats); `reread`: the row a lost write reads again. */
  function store(
    operations: ResendRow[],
    refund: { paymentTransactionId: string | null; status: string } | null = { paymentTransactionId: TXN, status: "succeeded" },
    written: number | number[] = 1,
    reread: Pick<ResendRow, "status" | "allocationPlan"> | null = null,
  ) {
    const counts = Array.isArray(written) ? [...written] : [written];
    const updateMany = vi.fn(async (..._args: unknown[]) => ({ count: counts.length > 1 ? counts.shift()! : counts[0]! }));
    const findUnique = vi.fn(async () => reread);
    return {
      updateMany,
      findUnique,
      db: {
        paymentRefund: { findFirst: async () => (refund ? { ...refund, amountCents: 4_000, createdAt: MADE, stripeCreatedAt: MADE } : null) },
        paymentRecoveryOperation: { findMany: async () => operations, findUnique, updateMany },
      } as never,
    };
  }
  const pair = (db: never) => pairResendRecordedFirst(PAYMENT, { id: "re_s", metadata: runnerMetadata }, db);

  it("MUTATION (F1): a row that will replay its slice is left to: nothing is written", async () => {
    const { db, updateMany } = store([resendRow("row-1")]);
    expect(await pair(db)).toBe("replay");
    expect(updateMany).not.toHaveBeenCalled();
    // Mid-attempt on its last try is still its replay's to mark.
    const processing = store([{ ...resendRow("row-1", { status: "PROCESSING" }), attempts: 5 }]);
    expect(await pair(processing.db)).toBe("replay");
  });

  it("MUTATION (F2): a dead row's one such re-send is marked, compare-and-set on the plan, status and attempts read", async () => {
    const dead = resendRow("row-1", { dead: true });
    const { db, updateMany } = store([dead]);
    expect(await pair(db)).toBe("marked");
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "row-1", status: "FAILED", attempts: 5, allocationPlan: { equals: dead.allocationPlan } },
      data: { allocationPlan: [{ ...(dead.allocationPlan as object[])[0], madeRefundId: "re_s" }] },
    });
  });

  it("MUTATION (#4312 F1): a lost write on a dead row an officer just closed marks it on the plan alone, never the replay nobody sends", async () => {
    const dead = resendRow("row-1", { dead: true });
    const closed = { status: "SUCCEEDED", allocationPlan: dead.allocationPlan };
    const { db, updateMany, findUnique } = store([dead], undefined, [0, 1], closed);
    expect(await pair(db)).toBe("marked");
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "row-1" }, select: { status: true, allocationPlan: true } });
    expect(updateMany).toHaveBeenLastCalledWith({
      where: { id: "row-1", allocationPlan: { equals: dead.allocationPlan } },
      data: { allocationPlan: [{ ...(dead.allocationPlan as object[])[0], madeRefundId: "re_s" }] },
    });
  });

  it("#4312 F1: a lost write is read again - marked with this refund already is marked; anything else is logged and noted by nobody", async () => {
    const dead = resendRow("row-1", { dead: true });
    const slice = (dead.allocationPlan as object[])[0]!;
    // Another writer marked the slice with this refund.
    const markedElsewhere = store([dead], undefined, 0, { status: "FAILED", allocationPlan: [{ ...slice, madeRefundId: "re_s" }] });
    log.error.mockClear();
    expect(await pair(markedElsewhere.db)).toBe("marked");
    expect(markedElsewhere.updateMany).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
    // Still dead but re-planned, closed with its slice marked by another refund, or gone: noted by nobody, never "replay".
    for (const reread of [
      { status: "FAILED", allocationPlan: [{ ...slice, stripeKeySuffix: "refused2" }] },
      { status: "SUCCEEDED", allocationPlan: [{ ...slice, madeRefundId: "re_other" }] },
      null,
    ]) {
      const lost = store([dead], undefined, 0, reread);
      log.error.mockClear();
      expect(await pair(lost.db)).toBe("ambiguous");
      expect(lost.updateMany).toHaveBeenCalledTimes(1);
      expect(log.error).toHaveBeenCalledTimes(1);
    }
    // Closed, but the plan moved again before the mark: logged, not retried.
    expect(await pair(store([dead], undefined, 0, { status: "SUCCEEDED", allocationPlan: dead.allocationPlan }).db)).toBe("ambiguous");
  });

  it("#4312 F3: a live row's and a dead row's re-sends that could each be it are left to the live row's replay", async () => {
    const mixed = store([resendRow("row-1"), resendRow("row-2", { dead: true })]);
    log.warn.mockClear();
    expect(await pair(mixed.db)).toBe("replay");
    expect(mixed.updateMany).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ operationIds: ["row-1", "row-2"] }), expect.stringContaining("live row's or a dead row's"));
    // Live rows alone are not logged.
    log.warn.mockClear();
    expect(await pair(store([resendRow("row-1")]).db)).toBe("replay");
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("several dead rows' re-sends are not guessed at; a refund not counted is none", async () => {
    const two = store([resendRow("row-1", { dead: true }), resendRow("row-2", { dead: true })]);
    expect(await pair(two.db)).toBe("ambiguous");
    expect(two.updateMany).not.toHaveBeenCalled();
    expect(await pair(store([resendRow("row-1", { dead: true })], { paymentTransactionId: TXN, status: "failed" }).db)).toBe("none");
    expect(await pair(store([resendRow("row-1", { dead: true })], null).db)).toBe("none");
    expect(await pair(store([]).db)).toBe("none");
  });
});
