import { describe, expect, it, vi } from "vitest";
import { matchesWhere } from "@/lib/__tests__/support/prisma-where";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { findCreditNotesSpentOutsideApp } from "@/lib/xero-credit-note-spent-outside-flag";
import { CREDIT_NOTE_SPEND_EVIDENCE_KEY, type StoredCreditNoteSpendEvidence } from "@/lib/xero-credit-note-spend-evidence";

/**
 * #4220 (lane a): the early warning, judged from the reading kept at ingest. Every
 * case here runs against an in-memory store answered by the shared `where`
 * evaluator, and that store refuses every write: the check is read-only.
 */

const NOW = new Date("2026-07-01T00:00:00.000Z");
const SETTLED = "2026-06-30T20:00:00.000Z";

type Row = Record<string, unknown>;
interface Store {
  memberCredit: Row[];
  memberCreditNoteAllocation: Row[];
  xeroObjectLink: Row[];
  payment: Row[];
  booking: Row[];
  xeroSyncOperation: Row[];
}

const READS = new Set(["findMany", "findFirst", "groupBy", "aggregate", "count"]);

/** A read-only Prisma double: reads are evaluated with `matchesWhere`, any write throws. */
function readOnlyDb(store: Store) {
  const calls: string[] = [];
  const seen: Array<{ call: string; where?: Row }> = [];
  const model = (name: keyof Store) =>
    new Proxy(
      {},
      {
        get(_target, method: string) {
          return async (args: { where?: Row; by?: string[]; _sum?: Row; _count?: Row } = {}) => {
            calls.push(`${name}.${method}`);
            seen.push({ call: `${name}.${method}`, where: args.where });
            if (!READS.has(method)) throw new Error(`write attempted: ${name}.${method}`);
            const rows = store[name].filter((row) => matchesWhere(row, args.where));
            if (method === "findFirst") return rows[0] ?? null;
            if (method === "count") return rows.length;
            if (method === "aggregate") return { _sum: { amountCents: rows.reduce((sum, row) => sum + (row.amountCents as number), 0) } };
            if (method === "groupBy") {
              const key = args.by![0]!;
              const groups = new Map<unknown, Row[]>();
              for (const row of rows) groups.set(row[key], [...(groups.get(row[key]) ?? []), row]);
              return [...groups].map(([value, grouped]) => ({
                [key]: value,
                _count: { _all: grouped.length },
                _sum: { amountCents: grouped.reduce((sum, row) => sum + (row.amountCents as number), 0) },
              }));
            }
            return rows;
          };
        },
      },
    );
  const db = new Proxy(
    {},
    {
      get(_target, key: string) {
        if (key in store) return model(key as keyof Store);
        return () => {
          calls.push(key);
          throw new Error(`write attempted: ${key}`);
        };
      },
    },
  );
  return { db: db as never, calls, seen };
}

const credit = (row: Row): Row => ({
  type: "CANCELLATION_REFUND",
  xeroCreditNoteId: null,
  outsideSpendConvergedAt: null,
  appliedToBookingId: null,
  ...row,
});

const booking = (id: string, status = "CONFIRMED"): Row => ({ id, status, payment: { id: `pay_${id}` } });

/** An allocation attempt an officer resolved in Xero, or the converge closed (`manuallyResolvedAt` set). */
const resolvedOp = (row: Row): Row => ({
  direction: "OUTBOUND",
  entityType: "ALLOCATION",
  operationType: "ALLOCATE",
  status: "FAILED",
  queueType: null,
  requestPayload: null,
  correlationKey: null,
  idempotencyKey: null,
  manuallyResolvedAt: new Date(SETTLED),
  manuallyResolvedReason: "Allocated by hand in Xero",
  createdAt: new Date(SETTLED),
  updatedAt: new Date(SETTLED),
  ...row,
});

function reading(overrides: Partial<StoredCreditNoteSpendEvidence> = {}): StoredCreditNoteSpendEvidence {
  return {
    status: "AUTHORISED",
    totalCents: 10_000,
    remainingCents: 3_000,
    // Booking 0's own allocation, and 3,000 spent on an invoice the app has no record of.
    allocations: [
      { invoiceId: "inv_b0", cents: 4_000 },
      { invoiceId: "inv_outside", cents: 3_000 },
    ],
    payments: [],
    noteUpdatedAt: SETTLED,
    observedAt: SETTLED,
    ...overrides,
  };
}

/**
 * Member m1's lot L1 (10,000) on note N1. Booking b0's slice (4,000) is held in
 * Xero; booking b1's slice (6,000) is not yet allocated. Xero shows 3,000 of the
 * note spent outside the app, so 3,000 is left where the app still needs 6,000.
 */
function store(options: { reading?: StoredCreditNoteSpendEvidence | null; extra?: Partial<Store>; b1SliceCents?: number; heldB0?: boolean } = {}): Store {
  const b1 = options.b1SliceCents ?? 6_000;
  const evidence = options.reading === undefined ? reading() : options.reading;
  return {
    memberCredit: [
      credit({ id: "L1", memberId: "m1", amountCents: 10_000, xeroCreditNoteId: "N1" }),
      credit({ id: "a0", memberId: "m1", amountCents: -4_000, type: "BOOKING_APPLIED", appliedToBookingId: "b0", xeroCreditNoteId: "N1" }),
      credit({ id: "a1", memberId: "m1", amountCents: -b1, type: "BOOKING_APPLIED", appliedToBookingId: "b1" }),
      ...(options.extra?.memberCredit ?? []),
    ],
    memberCreditNoteAllocation: [
      { id: "s0", memberCreditId: "L1", xeroCreditNoteId: "N1", appliedToBookingId: "b0", amountCents: 4_000 },
      { id: "s1", memberCreditId: "L1", xeroCreditNoteId: "N1", appliedToBookingId: "b1", amountCents: b1 },
      ...(options.extra?.memberCreditNoteAllocation ?? []),
    ],
    xeroObjectLink: [
      ...(options.heldB0 === false
        ? []
        : [{ localModel: "MemberCreditNoteAllocation", localId: "s0", xeroObjectType: "ALLOCATION", xeroObjectId: "alloc_0", role: "APPLIED_CREDIT_ALLOCATION", active: true, metadata: null }]),
      {
        localModel: "Payment",
        localId: "pay_src",
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: "N1",
        role: "ACCOUNT_CREDIT_NOTE",
        active: true,
        metadata: evidence ? { status: "AUTHORISED", [CREDIT_NOTE_SPEND_EVIDENCE_KEY]: evidence } : { status: "AUTHORISED" },
      },
      ...(options.extra?.xeroObjectLink ?? []),
    ],
    payment: [
      { id: "pay_b0", xeroInvoiceId: "inv_b0" },
      { id: "pay_b1", xeroInvoiceId: "inv_b1" },
      ...(options.extra?.payment ?? []),
    ],
    booking: [booking("b0"), booking("b1"), ...(options.extra?.booking ?? [])],
    xeroSyncOperation: [...(options.extra?.xeroSyncOperation ?? [])],
  };
}

const find = (s: Store, options: { bookingIds?: string[] } = {}) => findCreditNotesSpentOutsideApp(readOnlyDb(s).db, { ...options, now: NOW });

describe("the early warning: a credit note spent in Xero outside the app (#4220)", () => {
  it("flags the note when Xero has less left on it than the app still has to allocate, naming only the waiting booking", async () => {
    const [flag, ...rest] = await find(store());
    expect(rest).toEqual([]);
    expect(flag).toEqual({
      creditNoteId: "N1",
      memberId: "m1",
      lotId: "L1",
      xeroRemainingCents: 3_000,
      pendingAllocationCents: 6_000,
      pendingSliceCents: 6_000,
      unslicedDrawCents: 0,
      outsideSpendCents: 3_000,
      leftForAllocationCents: 3_000,
      bookingIds: ["b1"],
      resolvedAllocations: [],
      observedAt: new Date(SETTLED),
    });
  });

  it("finds it from the waiting booking's scope, not from one Xero already holds or one that draws on no lot", async () => {
    expect((await find(store(), { bookingIds: ["b1"] })).map((f) => f.creditNoteId)).toEqual(["N1"]);
    expect((await find(store(), { bookingIds: ["b0", "b1"] })).map((f) => f.creditNoteId)).toEqual(["N1"]);
    expect(await find(store(), { bookingIds: ["b0"] })).toEqual([]);
    expect(await find(store(), { bookingIds: ["b9"] })).toEqual([]);
    expect(await find(store(), { bookingIds: [] })).toEqual([]);
  });

  // Booking b0 holds 3,000 in Xero and b1 waits for `b1SliceCents`; 1,000 went on an
  // outside invoice and the member's balance is nil, so the mirror can absorb none of it.
  const balanceLimited = (b1SliceCents: number) =>
    store({
      b1SliceCents,
      reading: reading({
        remainingCents: 6_000,
        allocations: [
          { invoiceId: "inv_b0", cents: 3_000 },
          { invoiceId: "inv_outside", cents: 1_000 },
        ],
      }),
      extra: { memberCredit: [credit({ id: "adj", memberId: "m1", amountCents: -(10_000 - 3_000 - b1SliceCents), type: "ADMIN_ADJUSTMENT" })] },
    });
  const withB0Slice = (s: Store, cents: number): Store => ({
    ...s,
    memberCreditNoteAllocation: s.memberCreditNoteAllocation.map((slice) => (slice.id === "s0" ? { ...slice, amountCents: cents } : slice)),
    memberCredit: s.memberCredit.map((row) => (row.id === "a0" ? { ...row, amountCents: -cents } : row)),
  });

  it("does not flag when Xero's remaining credit equals what the app still has to allocate", async () => {
    expect(await find(withB0Slice(balanceLimited(6_000), 3_000))).toEqual([]);
  });

  it("does not flag when Xero has more left than the app still has to allocate", async () => {
    expect(await find(withB0Slice(balanceLimited(5_000), 3_000))).toEqual([]);
  });

  it("flags the same note once Xero has a cent less than the app needs", async () => {
    const flags = await find(withB0Slice(balanceLimited(6_001), 3_000));
    expect(flags.map((f) => [f.xeroRemainingCents, f.pendingAllocationCents])).toEqual([[6_000, 6_001]]);
  });

  it.each([
    ["no reading was kept", null],
    ["the reading is malformed", { ...reading(), remainingCents: "3000" } as unknown as StoredCreditNoteSpendEvidence],
    ["Xero's list does not explain what the note lost", reading({ remainingCents: 2_000 })],
    ["the note is voided", reading({ status: "VOIDED" })],
    ["the note's remaining credit could not be read", reading({ remainingCents: null })],
    ["the note changed under two minutes ago", reading({ noteUpdatedAt: "2026-06-30T23:59:00.000Z" })],
    ["the note's change time is unknown", reading({ noteUpdatedAt: null })],
  ])("raises no flag when %s (no false positives from an outage or a half-written list)", async (_label, evidence) => {
    expect(await find(store({ reading: evidence }))).toEqual([]);
  });

  it("raises no flag when the spend is the app's own, even though Xero has less left", async () => {
    const own = store({ extra: { xeroObjectLink: [{ localModel: "Booking", localId: "b9", xeroObjectType: "INVOICE", xeroObjectId: "inv_outside", role: "PRIMARY", active: true, metadata: null }] } });
    expect(await find(own)).toEqual([]);
  });

  it("raises no flag once the ledger has absorbed the spend (written down to match Xero)", async () => {
    const absorbed = store({
      extra: { memberCredit: [credit({ id: "wd", memberId: "m1", amountCents: -3_000, type: "ADMIN_ADJUSTMENT", xeroCreditNoteId: "N1", outsideSpendConvergedAt: new Date(SETTLED) })] },
    });
    expect(await find(absorbed)).toEqual([]);
  });

  it("leaves alone a note that funds more than one lot, as the mirror does", async () => {
    const shared = store({ extra: { memberCredit: [credit({ id: "L2", memberId: "m2", amountCents: 500, xeroCreditNoteId: "N1" })] } });
    expect(await find(shared)).toEqual([]);
  });

  it("raises no flag when every slice is already held in Xero: nothing is left to refuse", async () => {
    const allHeld = store({
      extra: { xeroObjectLink: [{ localModel: "MemberCreditNoteAllocation", localId: "s1", xeroObjectType: "ALLOCATION", xeroObjectId: "alloc_1", role: "APPLIED_CREDIT_ALLOCATION", active: true, metadata: null }] },
    });
    expect(await find(allHeld)).toEqual([]);
  });

  it("reads the newest reading by Xero's change time, not by when it was taken", async () => {
    const s = store();
    s.xeroObjectLink.push({
      localModel: "Booking",
      localId: "b7",
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: "N1",
      role: "CANCELLATION_CREDIT_NOTE",
      active: true,
      // Taken later, but of an older change of the note (an event processed out of order): it must not win.
      metadata: {
        [CREDIT_NOTE_SPEND_EVIDENCE_KEY]: reading({ remainingCents: 6_000, allocations: [{ invoiceId: "inv_b0", cents: 4_000 }], noteUpdatedAt: "2026-06-30T19:00:00.000Z", observedAt: "2026-06-30T23:00:00.000Z" }),
      },
    });
    expect((await find(s)).map((f) => f.xeroRemainingCents)).toEqual([3_000]);
  });

  it("reads the newest reading when a note has several links", async () => {
    const s = store();
    s.xeroObjectLink.push({
      localModel: "Payment",
      localId: "pay_other",
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: "N1",
      role: "APPLIED_CREDIT_REMAINDER_NOTE",
      active: true,
      // Older, and from before the outside spend: it must not win.
      metadata: { [CREDIT_NOTE_SPEND_EVIDENCE_KEY]: reading({ remainingCents: 6_000, allocations: [{ invoiceId: "inv_b0", cents: 4_000 }], observedAt: "2026-06-30T10:00:00.000Z" }) },
    });
    expect((await find(s)).map((f) => f.xeroRemainingCents)).toEqual([3_000]);
  });

  // Finding 1 of review round 1: the warning must come before the engine's first attempt.
  // Member m2 applied all of a 100.00 lot on note N2 to booking b2; no slice exists yet
  // (a card booking allocates at invoice or capture), and the treasurer offset N2 in Xero.
  const early = (extra: Partial<Store> = {}): Store => ({
    memberCredit: [
      credit({ id: "L2", memberId: "m2", amountCents: 10_000, xeroCreditNoteId: "N2" }),
      credit({ id: "a2", memberId: "m2", amountCents: -10_000, type: "BOOKING_APPLIED", appliedToBookingId: "b2" }),
      ...(extra.memberCredit ?? []),
    ],
    memberCreditNoteAllocation: [...(extra.memberCreditNoteAllocation ?? [])],
    xeroObjectLink: [
      {
        localModel: "Payment",
        localId: "pay_src2",
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: "N2",
        role: "ACCOUNT_CREDIT_NOTE",
        active: true,
        metadata: { [CREDIT_NOTE_SPEND_EVIDENCE_KEY]: reading({ remainingCents: 0, allocations: [{ invoiceId: "inv_offset", cents: 10_000 }] }) },
      },
      ...(extra.xeroObjectLink ?? []),
    ],
    payment: [{ id: "pay_b2", xeroInvoiceId: null }, ...(extra.payment ?? [])],
    booking: [booking("b2"), ...(extra.booking ?? [])],
    xeroSyncOperation: [...(extra.xeroSyncOperation ?? [])],
  });

  it("warns before any slice exists: applied credit not yet allocated counts against the note", async () => {
    const [flag, ...rest] = await find(early());
    expect(rest).toEqual([]);
    expect(flag).toMatchObject({
      creditNoteId: "N2",
      lotId: "L2",
      xeroRemainingCents: 0,
      pendingAllocationCents: 10_000,
      pendingSliceCents: 0,
      unslicedDrawCents: 10_000,
      outsideSpendCents: 10_000,
      leftForAllocationCents: 10_000,
      bookingIds: ["b2"],
      resolvedAllocations: [],
    });
    // The repair check's scope finds it from the booking, with no slice to lead there.
    expect((await find(early(), { bookingIds: ["b2"] })).map((f) => f.creditNoteId)).toEqual(["N2"]);
  });

  it("does not warn early when Xero still has what the unsliced credit will draw", async () => {
    // The member applied 4,000; the other 6,000 is free and Xero has 6,000 left after a 4,000 offset.
    const partial = early({ memberCredit: [] });
    partial.memberCredit = partial.memberCredit.map((row) => (row.id === "a2" ? { ...row, amountCents: -4_000 } : row));
    partial.xeroObjectLink[0]!.metadata = { [CREDIT_NOTE_SPEND_EVIDENCE_KEY]: reading({ remainingCents: 6_000, allocations: [{ invoiceId: "inv_offset", cents: 4_000 }] }) };
    expect(await find(partial)).toEqual([]);
  });

  it("caps the unsliced draw at what the lot has left to give", async () => {
    // Booking b3 applied 5,000 more, from a noteless 5,000 lot: the unsliced credit is 15,000, but N2's lot has only 10,000 to give.
    const capped = early({ memberCredit: [credit({ id: "a3", memberId: "m2", amountCents: -5_000, type: "BOOKING_APPLIED", appliedToBookingId: "b3" }), credit({ id: "L0", memberId: "m2", amountCents: 5_000 })] });
    capped.booking.push(booking("b3"));
    const [flag] = await find(capped);
    expect(flag).toMatchObject({ unslicedDrawCents: 10_000, pendingAllocationCents: 10_000, bookingIds: ["b2", "b3"] });
  });

  it("leaves out a cancelled booking: the converge refuses one", async () => {
    expect(await find({ ...early(), booking: [booking("b2", "CANCELLED")] })).toEqual([]);
    const s = store();
    s.booking = [booking("b0"), booking("b1", "CANCELLED")];
    expect(await find(s)).toEqual([]);
  });

  it("clears once the booking's queued allocation is resolved in Xero by an officer", async () => {
    const op = resolvedOp({ id: "op_b2", localModel: "Payment", localId: "pay_b2", queueType: "APPLIED_CREDIT_ALLOCATION", requestPayload: { queueType: "APPLIED_CREDIT_ALLOCATION", bookingId: "b2" } });
    expect(await find(early({ xeroSyncOperation: [op] }))).toEqual([]);
    // A newer live attempt outranks the old resolved one: the warning stands.
    const live = { ...op, id: "op_b2_live", status: "PENDING", manuallyResolvedAt: null, manuallyResolvedReason: null };
    expect((await find(early({ xeroSyncOperation: [op, live] }))).map((f) => f.creditNoteId)).toEqual(["N2"]);
  });

  it("clears once the slice's own attempt was closed by the converge", async () => {
    const s = store({
      extra: {
        xeroSyncOperation: [
          resolvedOp({ id: "op_s1", localModel: "MemberCreditNoteAllocation", localId: "s1", manuallyResolvedReason: "CREDIT_SPENT_OUTSIDE_APP: the credit note was used in Xero outside the app" }),
        ],
      },
    });
    expect(await find(s)).toEqual([]);
  });

  it("reports a resolved booking apart while another booking still waits on the same note", async () => {
    const op = resolvedOp({ id: "op_b3", localModel: "Payment", localId: "pay_b3", queueType: "APPLIED_CREDIT_ALLOCATION", requestPayload: { queueType: "APPLIED_CREDIT_ALLOCATION", bookingId: "b3" } });
    const s = early({
      memberCredit: [credit({ id: "a3", memberId: "m2", amountCents: -4_000, type: "BOOKING_APPLIED", appliedToBookingId: "b3" })],
      booking: [booking("b3")],
      xeroSyncOperation: [op],
    });
    s.memberCredit = s.memberCredit.map((row) => (row.id === "a2" ? { ...row, amountCents: -6_000 } : row));
    const [flag, ...rest] = await find(s);
    expect(rest).toEqual([]);
    expect(flag).toMatchObject({ bookingIds: ["b2"], unslicedDrawCents: 6_000, pendingAllocationCents: 6_000 });
    expect(flag!.resolvedAllocations).toEqual([{ bookingId: "b3", operation: expect.objectContaining({ id: "op_b3" }) }]);
    // Asked for the resolved booking alone, the note still comes back, for its resolved report.
    expect((await find(s, { bookingIds: ["b3"] })).map((f) => f.creditNoteId)).toEqual(["N2"]);
  });

  it("counts only this note's slices of the lot as owed to it", async () => {
    // b1's slice rides a different note (a minted remainder): N1 owes it nothing.
    const s = store();
    s.memberCreditNoteAllocation = s.memberCreditNoteAllocation.map((slice) => (slice.id === "s1" ? { ...slice, xeroCreditNoteId: "M9" } : slice));
    expect(await find(s)).toEqual([]);
  });

  it("reads only the slices of lots whose note has a judged reading, never every slice", async () => {
    const s = store({
      extra: {
        memberCredit: [credit({ id: "Lx", memberId: "m9", amountCents: 500, xeroCreditNoteId: "Nx" })],
        memberCreditNoteAllocation: [{ id: "sx", memberCreditId: "Lx", xeroCreditNoteId: "Nx", appliedToBookingId: "bx", amountCents: 500 }],
      },
    });
    const { db, seen } = readOnlyDb(s);
    expect(await findCreditNotesSpentOutsideApp(db, { now: NOW })).toHaveLength(1);
    const sliceReads = seen.filter((entry) => entry.call === "memberCreditNoteAllocation.findMany");
    expect(sliceReads.map((entry) => entry.where)).toEqual([{ memberCreditId: { in: ["L1"] } }]);
    const heldReads = seen.filter((entry) => entry.call === "xeroObjectLink.findMany" && JSON.stringify(entry.where).includes("MemberCreditNoteAllocation"));
    expect(JSON.stringify(heldReads)).not.toContain("sx");
  });

  it("writes nothing: every call it makes is a read", async () => {
    const { db, calls } = readOnlyDb(store());
    expect(await findCreditNotesSpentOutsideApp(db, { now: NOW })).toHaveLength(1);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => READS.has(call.split(".")[1] ?? ""))).toBe(true);
  });
});
