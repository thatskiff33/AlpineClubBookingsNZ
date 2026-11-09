import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3924 rounds 11 and 12 (`INV-PAY-122`): what the repair tool's record-by-hand
 * finding for a refund closed as paid another way names - the capture's own
 * card refunds (`PaymentRefund` rows by intent) less the refund notes naming
 * the capture, plus what the close paid back. Never the capture row's
 * `refundedAmountCents`, which also carries any other hand-back allocated to
 * it. Read only when the paid-another-way verdict says the receipt was
 * resolved by hand. The card-refund reader is the real one, over a stubbed
 * store. Round 13: only a card note that reached Xero is taken off.
 */
const mocks = vi.hoisted(() => ({
  receipt: vi.fn(),
  cardReceipt: vi.fn(),
  close: vi.fn(),
  capture: vi.fn(),
  refunds: vi.fn(),
  notes: vi.fn(),
  noteRows: vi.fn(),
  links: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    manualRefundTask: { findUnique: async () => ({ id: "task_late", paymentId: "payment_1" }) },
    xeroObjectLink: { findMany: (...a: unknown[]) => mocks.links(...a) },
    xeroSyncOperation: {
      count: (...a: unknown[]) => mocks.noteRows(...a),
      findMany: (...a: unknown[]) => mocks.notes(...a),
    },
    paymentTransaction: { findFirst: (...a: unknown[]) => mocks.capture(...a) },
    paymentRefund: { findMany: (...a: unknown[]) => mocks.refunds(...a) },
  },
}));
vi.mock("@/lib/late-capture-xero-receipt", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/late-capture-xero-receipt")),
  readPaidAnotherWayLateCaptureXeroReceipt: (...a: unknown[]) => mocks.receipt(...a),
  readLateCaptureXeroReceipt: (...a: unknown[]) => mocks.cardReceipt(...a),
}));
vi.mock("@/lib/late-capture-paid-another-way", () => ({
  findLateCaptureRefundPaidAnotherWay: (...a: unknown[]) => mocks.close(...a),
  // #4516 (round-2 review A): every close of the capture's refund; one here unless a test gives a list.
  findLateCaptureRefundPaidAnotherWayCloses: async (...a: unknown[]) => {
    const found = (await mocks.close(...a)) as unknown;
    return Array.isArray(found) ? found : found ? [found] : [];
  },
}));
vi.mock("@/lib/club-time-zone-runtime", () => ({ readClubTimeZoneOutsideRequest: vi.fn() }));
vi.mock("@/lib/xero-kept-late-capture-invoice", () => ({ lockKeptLateCaptureTask: vi.fn() }));

import { readPaidAnotherWayReceiptState } from "@/lib/paid-another-way-receipt-note";
import {
  classifyLateCaptureCardNote,
  readUnnotedLateCaptureCardRefunds,
  sumLateCaptureNotedCents,
} from "@/lib/late-capture-refund-credit-note";
import { XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE } from "@/lib/xero-operation-outbox-payload";

const cardNote = (amountCents: number) => ({
  status: "SUCCEEDED",
  lastErrorCode: null as string | null,
  xeroObjectId: "cn_card" as string | null,
  manuallyResolvedAt: null,
  requestPayload: { queueType: XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE, refundAmountCents: amountCents, paymentIntentId: "pi_late" },
});

/** Round 14: the record-by-hand share alone. */
const byHandCentsOf = async (paymentId: string, paymentIntentId: string) =>
  (await readUnnotedLateCaptureCardRefunds(paymentId, paymentIntentId)).byHandCents;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.receipt.mockResolvedValue({ kind: "resolved-by-hand" });
  mocks.cardReceipt.mockResolvedValue({ kind: "resolved-by-hand" });
  mocks.close.mockResolvedValue({ id: "close_1", paymentId: "payment_1", amountCents: 6000 });
  mocks.noteRows.mockResolvedValue(0);
  // The capture row: 4000 to the card, 6000 closed as paid another way, and a
  // later 5000 hand-back that landed on the same row.
  mocks.capture.mockResolvedValue({ refundedAmountCents: 15000 });
  mocks.refunds.mockResolvedValue([
    { amountCents: 4000, status: "succeeded", stripeCreatedAt: null, createdAt: new Date("2026-06-20T00:00:00Z") },
  ]);
  mocks.notes.mockResolvedValue([cardNote(1000)]);
  mocks.links.mockResolvedValue([]);
});

describe("readPaidAnotherWayReceiptState: recordByHandCents (rounds 11 and 12)", () => {
  it("MUTATION: round 12: is the capture's own card refunds less the notes naming it, plus the close - never a later hand-back on the capture row", async () => {
    const state = await readPaidAnotherWayReceiptState("pi_late");
    // 4000 card - 1000 noted + 6000 closed; the 5000 hand-back is not the capture's.
    expect(state).toMatchObject({ close: { id: "close_1", amountCents: 6000 }, noteAsked: false, recordByHandCents: 9000 });
    expect(mocks.receipt).toHaveBeenCalledWith("pi_late");
    expect(mocks.refunds).toHaveBeenCalledWith(
      expect.objectContaining({ where: { paymentId: "payment_1", stripePaymentIntentId: "pi_late" } }),
    );
    expect(mocks.notes).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ localId: "payment_1", requestPayload: { path: ["paymentIntentId"], equals: "pi_late" } }),
      }),
    );
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("counts only succeeded card refunds, and never takes a card note below nothing off the close", async () => {
    mocks.refunds.mockResolvedValue([
      { amountCents: 4000, status: "failed", stripeCreatedAt: null, createdAt: new Date() },
      { amountCents: 2000, status: "succeeded", stripeCreatedAt: null, createdAt: new Date() },
    ]);
    // 2000 succeeded - 1000 noted + 6000 closed; the failed 4000 never counts.
    await expect(readPaidAnotherWayReceiptState("pi_late")).resolves.toMatchObject({ recordByHandCents: 7000 });
    mocks.notes.mockResolvedValue([cardNote(12000)]);
    await expect(readPaidAnotherWayReceiptState("pi_late")).resolves.toMatchObject({ recordByHandCents: 6000 });
    mocks.refunds.mockResolvedValue([]);
    await expect(readPaidAnotherWayReceiptState("pi_late")).resolves.toMatchObject({ recordByHandCents: 6000 });
  });

  it("MUTATION (#4516 round-2 review A): a part close and its still-owed rest's close count together, and the note is asked only when both are", async () => {
    const waiting = (id: string, amountCents: number) => ({ id, paymentId: "payment_1", amountCents, kind: "CANCELLED_BOOKING_HAND_BACK",
      occurrenceKey: `card-refund-paid-another-way:op-${id}:note-after-receipt` });
    mocks.close.mockResolvedValue([waiting("close_1", 2000), waiting("close_2", 4000)]);
    // 4000 card - 1000 noted + 2000 + 4000 closed.
    await expect(readPaidAnotherWayReceiptState("pi_late")).resolves.toMatchObject({ close: { id: "close_1", amountCents: 6000 }, noteAsked: false, recordByHandCents: 9000 });
    mocks.noteRows.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    await expect(readPaidAnotherWayReceiptState("pi_late")).resolves.toMatchObject({ noteAsked: false });
    mocks.noteRows.mockResolvedValue(1);
    await expect(readPaidAnotherWayReceiptState("pi_late")).resolves.toMatchObject({ noteAsked: true });
  });

  it("is nothing for a receipt the app recorded: its note follows", async () => {
    mocks.receipt.mockResolvedValue({ kind: "recorded", invoiceId: "inv_kept" });
    await expect(readPaidAnotherWayReceiptState("pi_late")).resolves.toMatchObject({ recordByHandCents: 0 });
    expect(mocks.refunds).not.toHaveBeenCalled();
  });
});

/**
 * #3924 round 13 (F1, `INV-PAY-122`): once the receipt is resolved by hand, a
 * card note that never reached Xero - queued, or FAILED while it waited for
 * the receipt - completes as skipped when it next runs, so it answers nothing
 * and its cents are recorded by hand. Only a note with its Xero credit note,
 * or one resolved by hand in Xero, is taken off. The note writer's own ask is
 * sized the other way: a queued or failed note is not asked for again.
 */
describe("round 13: only a card note in Xero is taken off what is recorded by hand", () => {
  /** A card note that FAILED while it waited for the receipt: never in Xero. */
  const waitingNote = (amountCents: number) => ({ ...cardNote(amountCents), status: "FAILED", xeroObjectId: null });

  it("MUTATION: card only - a FAILED waiting card note is still recorded by hand", async () => {
    mocks.notes.mockResolvedValue([waitingNote(1000)]);
    await expect(byHandCentsOf("payment_1", "pi_late")).resolves.toBe(4000);
    // Beside one in Xero, only that one comes off.
    mocks.notes.mockResolvedValue([cardNote(1000), waitingNote(500), { ...waitingNote(700), status: "PENDING" }]);
    await expect(byHandCentsOf("payment_1", "pi_late")).resolves.toBe(3000);
  });

  it("MUTATION: card only - a card note resolved by hand in Xero is taken off", async () => {
    mocks.notes.mockResolvedValue([{ ...waitingNote(1500), manuallyResolvedAt: new Date("2026-06-21T00:00:00Z") }]);
    await expect(byHandCentsOf("payment_1", "pi_late")).resolves.toBe(2500);
  });

  it("MUTATION: split - the close's finding names the FAILED waiting card note's cents with the close", async () => {
    mocks.notes.mockResolvedValue([waitingNote(1000)]);
    // 4000 card, none in Xero, + 6000 closed.
    await expect(readPaidAnotherWayReceiptState("pi_late")).resolves.toMatchObject({ recordByHandCents: 10000 });
  });

  it("MUTATION: the note writer's own ask still counts a queued or failed note, so it is never asked for twice", async () => {
    mocks.notes.mockResolvedValue([cardNote(1000), waitingNote(500), { ...waitingNote(700), status: "PENDING" }]);
    await expect(sumLateCaptureNotedCents("payment_1", "pi_late")).resolves.toBe(2200);
    await expect(readUnnotedLateCaptureCardRefunds("payment_1", "pi_late")).resolves.toEqual({
      byHandCents: 3000,
      mayBeInXeroCents: 0,
      notesCanStillLand: false,
      notedLaterCents: 0,
    });
  });
});

/**
 * #3924 round 14 (`INV-PAY-122`): a card note row stands one of THREE ways. In
 * Xero (its id, or resolved by hand) is taken off; never sent (the queued
 * payload) is recorded by hand; SENT WITH THE OUTCOME UNKNOWN - the executed
 * payload (`creditNotes`) and no id, a lost reply - may be in Xero, so it is
 * never in the record-by-hand figure but named apart, for the officer to check
 * Xero first. While the card verdict still names an invoice in Xero, a waiting
 * note can still land, so the figure is the note writer's own count.
 */
describe("round 14: a card note sent with the outcome unknown is named apart, never recorded by hand", () => {
  /** A card note whose `createCreditNotes` call was made but whose reply was lost: FAILED, executed payload, no id. */
  const sentNote = (amountCents: number, status = "FAILED") => ({
    status,
    lastErrorCode: null as string | null,
    xeroObjectId: null as string | null,
    manuallyResolvedAt: null,
    requestPayload: {
      creditNotes: [{ lineItems: [{ unitAmount: amountCents / 100 }] }],
      allocation: { invoiceId: "inv_change", amount: amountCents / 100 },
      refundMethod: "card",
      paymentIntentId: "pi_late",
    },
  });
  const waitingNote = (amountCents: number) => ({ ...cardNote(amountCents), status: "FAILED", xeroObjectId: null });

  it("classifies each note row one of three ways", () => {
    expect(classifyLateCaptureCardNote(cardNote(1000))).toBe("in-xero");
    expect(classifyLateCaptureCardNote({ ...sentNote(1000), manuallyResolvedAt: new Date() })).toBe("in-xero");
    expect(classifyLateCaptureCardNote(sentNote(1000))).toBe("sent-outcome-unknown");
    expect(classifyLateCaptureCardNote(waitingNote(1000))).toBe("never-sent");
  });

  it("MUTATION: card only - a FAILED note with the executed payload is named apart, not recorded by hand", async () => {
    mocks.notes.mockResolvedValue([sentNote(1500)]);
    await expect(readUnnotedLateCaptureCardRefunds("payment_1", "pi_late")).resolves.toEqual({
      byHandCents: 2500,
      mayBeInXeroCents: 1500,
      notesCanStillLand: false,
      notedLaterCents: 0,
    });
    // Beside one in Xero and one never sent: only the in-Xero one comes off,
    // the never-sent one is recorded by hand, the sent one is named apart.
    mocks.notes.mockResolvedValue([cardNote(1000), waitingNote(500), sentNote(700)]);
    await expect(readUnnotedLateCaptureCardRefunds("payment_1", "pi_late")).resolves.toEqual({
      byHandCents: 2300,
      mayBeInXeroCents: 700,
      notesCanStillLand: false,
      notedLaterCents: 0,
    });
    // A sent note completed as skipped on a later run is still maybe in Xero.
    mocks.notes.mockResolvedValue([sentNote(700, "SUCCEEDED")]);
    await expect(readUnnotedLateCaptureCardRefunds("payment_1", "pi_late")).resolves.toMatchObject({
      byHandCents: 3300,
      mayBeInXeroCents: 700,
    });
  });

  it("never names more as maybe in Xero than is refunded and not in Xero", async () => {
    mocks.notes.mockResolvedValue([cardNote(3000), sentNote(2500)]);
    await expect(readUnnotedLateCaptureCardRefunds("payment_1", "pi_late")).resolves.toMatchObject({
      byHandCents: 0,
      mayBeInXeroCents: 1000,
    });
  });

  it("MUTATION: split - the close's finding records the close and the unsent card cents, and names the sent note apart", async () => {
    mocks.notes.mockResolvedValue([sentNote(1000)]);
    // 4000 card - 1000 maybe in Xero + 6000 closed.
    await expect(readPaidAnotherWayReceiptState("pi_late")).resolves.toMatchObject({
      recordByHandCents: 9000,
      cardNoteMayBeInXeroCents: 1000,
    });
  });

  it("MUTATION: while the card verdict names an invoice in Xero, a waiting note can still land - nothing by hand, the rest noted later", async () => {
    mocks.cardReceipt.mockResolvedValue({ kind: "recorded", invoiceId: "inv_kept" });
    mocks.notes.mockResolvedValue([cardNote(1000), waitingNote(500), sentNote(700)]);
    // 4000 - (1000 + 500 + 700) asked for: the app asks for 1800 the next time
    // it notes this charge; nothing is recorded by hand or named maybe in Xero.
    await expect(readUnnotedLateCaptureCardRefunds("payment_1", "pi_late")).resolves.toEqual({
      byHandCents: 0,
      mayBeInXeroCents: 0,
      notesCanStillLand: true,
      notedLaterCents: 1800,
    });
    expect(mocks.cardReceipt).toHaveBeenCalledWith("pi_late");
    // A receipt whose only row FAILED: nothing sends it, so nothing lands.
    mocks.cardReceipt.mockResolvedValue({ kind: "recorded", invoiceId: null, invoiceFailed: true });
    await expect(readUnnotedLateCaptureCardRefunds("payment_1", "pi_late")).resolves.toMatchObject({
      notesCanStillLand: false,
      byHandCents: 2300,
      notedLaterCents: 0,
    });
  });

  // Round 15 (2a): another receipt row still queued or sending is on its way
  // to Xero, so the capture's card notes can still land against it.
  it("MUTATION: round 15: a receipt row still on its way (no id, not FAILED) lets notes land", async () => {
    mocks.cardReceipt.mockResolvedValue({ kind: "recorded", invoiceId: null });
    mocks.notes.mockResolvedValue([cardNote(1000), waitingNote(500)]);
    await expect(readUnnotedLateCaptureCardRefunds("payment_1", "pi_late")).resolves.toEqual({
      byHandCents: 0,
      mayBeInXeroCents: 0,
      notesCanStillLand: true,
      notedLaterCents: 2500,
    });
  });
});

/**
 * #3924 round 15 (`INV-PAY-122`): an officer's retry of a FAILED card note
 * runs it again on a NEW row with no queue type, which still names the
 * capture's `paymentIntentId`, and the note it lands carries an active
 * `REFUND_CREDIT_NOTE` link naming it. Both count it in Xero, once. And a
 * FAILED row Xero refused (a 4xx `lastErrorCode`) was never taken.
 */
describe("round 15: an officer's retry of a card note, and a note Xero refused", () => {
  const queuedFailed = (amountCents: number) => ({ ...cardNote(amountCents), status: "FAILED", xeroObjectId: null });
  const retryRow = (amountCents: number, extra: Record<string, unknown> = {}) => ({
    status: "SUCCEEDED",
    lastErrorCode: null as string | null,
    xeroObjectId: "cn_1" as string | null,
    manuallyResolvedAt: null,
    requestPayload: {
      creditNotes: [{ lineItems: [{ unitAmount: amountCents / 100 }] }],
      allocation: { invoiceId: "inv_change", amount: amountCents / 100 },
      refundMethod: "card",
      paymentIntentId: "pi_late",
      ...extra,
    },
  });
  const cn1Link = { xeroObjectId: "cn_1", metadata: { amountCents: 40000, watermarkCents: 40000, paymentIntentId: "pi_late" } };

  beforeEach(() => {
    mocks.refunds.mockResolvedValue([
      { amountCents: 40000, status: "succeeded", stripeCreatedAt: null, createdAt: new Date("2026-06-20T00:00:00Z") },
    ]);
  });

  it("MUTATION: the $400 retry that landed CN-1 beside its FAILED queued row records nothing by hand", async () => {
    mocks.notes.mockResolvedValue([queuedFailed(40000), retryRow(40000)]);
    mocks.links.mockResolvedValue([cn1Link]);
    await expect(readUnnotedLateCaptureCardRefunds("payment_1", "pi_late")).resolves.toEqual({
      byHandCents: 0,
      mayBeInXeroCents: 0,
      notesCanStillLand: false,
      notedLaterCents: 0,
    });
    // The rows read are the queued ones and the retries with no queue type.
    expect(mocks.notes).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ queueType: XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE }, { queueType: null }],
          requestPayload: { path: ["paymentIntentId"], equals: "pi_late" },
        }),
      }),
    );
    // The links read are the capture's active refund-note links.
    expect(mocks.links).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          localId: "payment_1",
          role: "REFUND_CREDIT_NOTE",
          active: true,
          metadata: { path: ["paymentIntentId"], equals: "pi_late" },
        }),
      }),
    );
  });

  it("MUTATION: the link alone counts the note in Xero, and the link and its row count it once", async () => {
    mocks.notes.mockResolvedValue([queuedFailed(40000)]);
    mocks.links.mockResolvedValue([cn1Link]);
    await expect(byHandCentsOf("payment_1", "pi_late")).resolves.toBe(0);
    mocks.notes.mockResolvedValue([queuedFailed(40000), retryRow(40000)]);
    mocks.links.mockResolvedValue([{ ...cn1Link, metadata: { ...cn1Link.metadata, amountCents: 25000 } }]);
    // CN-1 holds 250 per its link, once: 150 is left.
    await expect(byHandCentsOf("payment_1", "pi_late")).resolves.toBe(15000);
  });

  it("MUTATION: a retry row is sorted the same three ways, and a close's row is never one", async () => {
    mocks.notes.mockResolvedValue([queuedFailed(40000), { ...retryRow(40000), status: "FAILED", xeroObjectId: null }]);
    await expect(readUnnotedLateCaptureCardRefunds("payment_1", "pi_late")).resolves.toMatchObject({
      byHandCents: 0,
      mayBeInXeroCents: 40000,
    });
    mocks.notes.mockResolvedValue([queuedFailed(40000), retryRow(40000, { paidAnotherWayTaskId: "close_1" })]);
    await expect(byHandCentsOf("payment_1", "pi_late")).resolves.toBe(40000);
  });

  it("MUTATION: a FAILED note Xero refused (4xx) was never taken, so it is recorded by hand", async () => {
    const refused = { ...retryRow(40000), status: "FAILED", xeroObjectId: null, lastErrorCode: "400" };
    expect(classifyLateCaptureCardNote(refused)).toBe("never-sent");
    mocks.notes.mockResolvedValue([refused]);
    await expect(readUnnotedLateCaptureCardRefunds("payment_1", "pi_late")).resolves.toMatchObject({
      byHandCents: 40000,
      mayBeInXeroCents: 0,
    });
    // A timeout, a rate limit or a server error is not a refusal: it may be in Xero.
    for (const lastErrorCode of ["408", "429", "500", null]) {
      expect(classifyLateCaptureCardNote({ ...refused, lastErrorCode })).toBe("sent-outcome-unknown");
    }
  });
});
