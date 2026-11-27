import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The outbox worker for a mid-season age-up CREDIT (#5190 PR 3,
 * `INV-MONEY-053`): one credit note allocated to the season invoice while that
 * invoice still owes at least the credit, otherwise one member credit lot.
 * Never both, and never twice.
 *
 * The database double keeps the adjustment row and applies each write's
 * `where`, so removing a claim guard from the code changes what these tests
 * observe.
 */

type Adjustment = {
  id: string;
  kind: "CREDIT" | "TOP_UP";
  status: "PENDING" | "CREDITED_ON_INVOICE" | "CREDITED_TO_ACCOUNT" | "VOIDED";
  amountCents: number;
  description: string;
  seasonYear: number;
  memberCreditId: string | null;
  xeroCreditNoteId: string | null;
};
type Charge = { xeroInvoiceId: string | null; status: string };

const store = vi.hoisted(() => ({
  adjustment: null as Adjustment | null,
  subscription: { status: "UNPAID", charge: null as Charge | null },
  existingNote: null as { xeroObjectId: string; xeroObjectNumber: string | null } | null,
}));

const db = vi.hoisted(() => ({
  memberSubscriptionAgeUpAdjustment: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
  xeroObjectLink: { findFirst: vi.fn() },
  xeroSyncOperation: { update: vi.fn() },
  $transaction: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  lockMemberCreditLedger: vi.fn(),
  postAgeUpCreditLot: vi.fn(),
  getInvoice: vi.fn(),
  createCreditNotes: vi.fn(),
  createCreditNoteAllocation: vi.fn(),
  getAuthenticatedXeroClient: vi.fn(),
  requireContained: vi.fn(),
  completeXeroSyncOperation: vi.fn(),
  failXeroSyncOperation: vi.fn(),
  upsertXeroObjectLink: vi.fn(),
  kick: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/club-format-server", () => ({ clubFormatValues: vi.fn(async () => ({ currency: "NZD" })) }));
vi.mock("@/lib/club-time-zone-runtime", () => ({
  readClubTimeZoneOutsideRequest: vi.fn(async () => "Pacific/Auckland"),
}));
vi.mock("@/lib/member-credit", () => ({ lockMemberCreditLedger: mocks.lockMemberCreditLedger }));
vi.mock("@/lib/member-credit-age-up", () => ({ postAgeUpCreditLot: mocks.postAgeUpCreditLot }));
vi.mock("@/lib/xero-api-client", () => ({
  callXeroApi: vi.fn(async (call: () => Promise<unknown>) => call()),
  getAuthenticatedXeroClient: mocks.getAuthenticatedXeroClient,
}));
vi.mock("@/lib/xero-contact-containment-proof", () => ({
  requireContainedXeroContactForInvoiceOperation: mocks.requireContained,
}));
vi.mock("@/lib/xero-mappings", () => ({
  getResolvedAccountMapping: vi.fn(async () => ({ code: "203", itemCode: null })),
}));
vi.mock("@/lib/xero-tax-anchors", () => import("./support/xero-tax-anchors-baseline"));
vi.mock("@/lib/xero-sync", () => ({
  buildXeroIdempotencyKey: (...parts: unknown[]) => parts.join(":"),
  sanitizeForJson: (value: unknown) => value,
  completeXeroSyncOperation: mocks.completeXeroSyncOperation,
  failXeroSyncOperation: mocks.failXeroSyncOperation,
  upsertXeroObjectLink: mocks.upsertXeroObjectLink,
  startXeroSyncOperation: vi.fn(),
}));
vi.mock("@/lib/xero-operation-outbox", () => ({ kickQueuedXeroOutboxOperationsIfConnected: mocks.kick }));

import { buildAgeUpCreditPayload } from "@/lib/age-up-credit-payload";
import { ageUpCreditIdempotencyKey } from "@/lib/subscription-age-up-billing";
import { createAgeUpCredit, creditAgeUpAdjustmentToAccount } from "@/lib/subscription-age-up-credit";
import { XeroAppliedCreditOperationBusyError } from "@/lib/xero-applied-credit-operation-serialization";
import { AGE_UP_CREDIT_AWAITING_SEASON_INVOICE_CODE } from "@/lib/xero-operation-error-codes";

const ADJUSTMENT_ID = "adjustment-0001";
const CREDIT_CENTS = 4500;
const DESCRIPTION = "Age group change: Adult to Senior from 15 June 2026";
const syncOperation = { id: "op-1", startedAt: new Date("2026-07-01T00:00:00.000Z") };

/** A flat `where`: every named column must equal the row's. */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([column, wanted]) => row[column] === wanted);
}

/** What Xero says the season invoice still owes, in dollars as Xero sends it. */
function seasonInvoiceOwes(amountDue: number) {
  mocks.getInvoice.mockResolvedValue({
    body: { invoices: [{ invoiceID: "inv-season", amountDue, contact: { contactID: "contact-1" } }] },
  });
}

const run = () => createAgeUpCredit({ syncOperation, payload: buildAgeUpCreditPayload(ADJUSTMENT_ID) });

beforeEach(() => {
  vi.clearAllMocks();
  store.adjustment = {
    id: ADJUSTMENT_ID,
    kind: "CREDIT",
    status: "PENDING",
    amountCents: CREDIT_CENTS,
    description: DESCRIPTION,
    seasonYear: 2026,
    memberCreditId: null,
    xeroCreditNoteId: null,
  };
  store.subscription = { status: "UNPAID", charge: { xeroInvoiceId: "inv-season", status: "EMAILED" } };
  store.existingNote = null;

  db.memberSubscriptionAgeUpAdjustment.findUnique.mockImplementation(async (args: { where: { id: string } }) => {
    const row = store.adjustment;
    if (!row || row.id !== args.where.id) return null;
    return {
      ...row,
      memberSubscription: {
        id: "subscription-1",
        memberId: "member-1",
        status: store.subscription.status,
        member: { xeroContactId: "contact-1" },
        chargeCoverage: store.subscription.charge ? [{ charge: store.subscription.charge }] : [],
      },
    };
  });
  db.memberSubscriptionAgeUpAdjustment.updateMany.mockImplementation(
    async (args: { where: Record<string, unknown>; data: Partial<Adjustment> }) => {
      const row = store.adjustment;
      if (!row || !matches(row, args.where)) return { count: 0 };
      Object.assign(row, args.data);
      return { count: 1 };
    },
  );
  db.memberSubscriptionAgeUpAdjustment.update.mockImplementation(
    async (args: { data: Partial<Adjustment> }) => Object.assign(store.adjustment!, args.data),
  );
  db.xeroObjectLink.findFirst.mockImplementation(async () => store.existingNote);
  db.$transaction.mockImplementation(async (work: (tx: typeof db) => unknown) => work(db));

  mocks.postAgeUpCreditLot.mockResolvedValue({ id: "credit-lot-1" });
  mocks.createCreditNotes.mockResolvedValue({
    body: { creditNotes: [{ creditNoteID: "note-1", creditNoteNumber: "CN-0042" }] },
  });
  mocks.createCreditNoteAllocation.mockResolvedValue({ body: {} });
  mocks.getAuthenticatedXeroClient.mockResolvedValue({
    tenantId: "tenant-1",
    xero: {
      accountingApi: {
        getInvoice: mocks.getInvoice,
        createCreditNotes: mocks.createCreditNotes,
        createCreditNoteAllocation: mocks.createCreditNoteAllocation,
      },
    },
  });
  seasonInvoiceOwes(120);
});

describe("createAgeUpCredit: credit note on the season invoice (#5190 PR 3)", () => {
  it("raises one note for the credit and allocates it while the invoice owes more than the credit", async () => {
    await run();

    expect(mocks.createCreditNotes).toHaveBeenCalledTimes(1);
    const [tenantId, body, , , idempotencyKey] = mocks.createCreditNotes.mock.calls[0]!;
    expect(tenantId).toBe("tenant-1");
    expect(body.creditNotes).toHaveLength(1);
    expect(body.creditNotes[0]).toMatchObject({
      contact: { contactID: "contact-1" },
      // The frozen test clock is 1 July 2026 in the club's zone.
      date: "2026-07-01",
      reference: "MEMSUB-AGEUP-adjustme",
      lineItems: [{ description: DESCRIPTION, quantity: 1, unitAmount: 45, accountCode: "203" }],
    });
    // The note's Xero key is the adjustment's own, so a retry cannot raise a second.
    expect(idempotencyKey).toBe(ageUpCreditIdempotencyKey(ADJUSTMENT_ID));

    expect(mocks.createCreditNoteAllocation).toHaveBeenCalledTimes(1);
    const [, noteId, allocation, , allocationKey] = mocks.createCreditNoteAllocation.mock.calls[0]!;
    expect(noteId).toBe("note-1");
    expect(allocation).toEqual({
      allocations: [{ invoice: { invoiceID: "inv-season" }, amount: 45, date: "2026-07-01" }],
    });
    expect(allocationKey).toBe(`credit-note:note-1:age-up:invoice:inv-season:${CREDIT_CENTS}:v1`);

    expect(store.adjustment).toMatchObject({
      status: "CREDITED_ON_INVOICE",
      xeroCreditNoteId: "note-1",
      memberCreditId: null,
    });
    expect(mocks.postAgeUpCreditLot).not.toHaveBeenCalled();
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledTimes(1);
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      syncOperation,
      expect.objectContaining({
        status: "SUCCEEDED",
        xeroObjectId: "note-1",
        responsePayload: { route: "credit-note", invoiceId: "inv-season", amountCents: CREDIT_CENTS, amountDueCents: 12000 },
      }),
    );
  });

  it("still allocates when the invoice owes exactly the credit", async () => {
    seasonInvoiceOwes(45);

    await run();

    expect(mocks.createCreditNotes).toHaveBeenCalledTimes(1);
    expect(store.adjustment!.status).toBe("CREDITED_ON_INVOICE");
    expect(mocks.postAgeUpCreditLot).not.toHaveBeenCalled();
  });

  it("allocates a note it already raised instead of raising another, whatever the invoice owes now", async () => {
    // An earlier attempt raised the note and failed before allocating it; the
    // invoice has since been part-paid below the credit.
    store.existingNote = { xeroObjectId: "note-earlier", xeroObjectNumber: "CN-0007" };
    seasonInvoiceOwes(10);

    await run();

    expect(mocks.createCreditNotes).not.toHaveBeenCalled();
    expect(mocks.createCreditNoteAllocation.mock.calls[0]![1]).toBe("note-earlier");
    expect(store.adjustment).toMatchObject({ status: "CREDITED_ON_INVOICE", xeroCreditNoteId: "note-earlier" });
    // A lot beside the note would credit the member twice.
    expect(mocks.postAgeUpCreditLot).not.toHaveBeenCalled();
  });

  it.each([
    ["became a credit lot", { status: "CREDITED_TO_ACCOUNT", memberCreditId: "credit-lot-9" }],
    ["was voided", { status: "VOIDED", memberCreditId: null }],
  ] as const)(
    "MUTATION (settle guard): leaves an adjustment that %s mid-flight as it is, and reports the operation partial",
    async (_what, settledElsewhere) => {
      // While the note is being allocated, the adjustment is settled another way.
      mocks.createCreditNoteAllocation.mockImplementation(async () => {
        Object.assign(store.adjustment!, settledElsewhere);
        return { body: {} };
      });

      await run();

      expect(store.adjustment).toMatchObject({ ...settledElsewhere, xeroCreditNoteId: null });
      expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
        syncOperation,
        expect.objectContaining({ status: "PARTIAL", xeroObjectId: "note-1" }),
      );
    },
  );

  it("records the failure and leaves the adjustment pending when Xero refuses the note", async () => {
    const refused = new Error("Xero is unavailable");
    mocks.createCreditNotes.mockRejectedValue(refused);

    await expect(run()).rejects.toBe(refused);

    expect(mocks.failXeroSyncOperation).toHaveBeenCalledWith(syncOperation, refused);
    expect(mocks.completeXeroSyncOperation).not.toHaveBeenCalled();
    expect(store.adjustment).toMatchObject({ status: "PENDING", xeroCreditNoteId: null, memberCreditId: null });
  });
});

describe("createAgeUpCredit: credit on the member's account (#5190 PR 3)", () => {
  const expectOneLot = () => {
    expect(mocks.postAgeUpCreditLot).toHaveBeenCalledTimes(1);
    expect(mocks.postAgeUpCreditLot).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        adjustmentId: ADJUSTMENT_ID,
        memberId: "member-1",
        amountCents: CREDIT_CENTS,
        description: DESCRIPTION,
      }),
    );
    expect(store.adjustment).toMatchObject({
      status: "CREDITED_TO_ACCOUNT",
      memberCreditId: "credit-lot-1",
      xeroCreditNoteId: null,
    });
    expect(mocks.createCreditNotes).not.toHaveBeenCalled();
    expect(mocks.createCreditNoteAllocation).not.toHaveBeenCalled();
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(syncOperation, {
      responsePayload: { route: "credit-lot", memberCreditId: "credit-lot-1", amountCents: CREDIT_CENTS },
    });
  };

  it("becomes a credit lot when the season invoice is already paid", async () => {
    seasonInvoiceOwes(0);

    await run();

    expectOneLot();
  });

  it("becomes a credit lot when the invoice owes one cent less than the credit", async () => {
    seasonInvoiceOwes(44.99);

    await run();

    expectOneLot();
  });

  it("becomes a credit lot, without asking Xero, when the season was paid with no invoice of this app's", async () => {
    store.subscription = { status: "PAID", charge: null };

    await run();

    expectOneLot();
    expect(mocks.getAuthenticatedXeroClient).not.toHaveBeenCalled();
  });

  it("takes the member's credit-ledger lock before it claims the adjustment", async () => {
    seasonInvoiceOwes(0);

    await run();

    expect(mocks.lockMemberCreditLedger).toHaveBeenCalledWith("member-1", db);
    const locked = mocks.lockMemberCreditLedger.mock.invocationCallOrder[0]!;
    const claimed = db.memberSubscriptionAgeUpAdjustment.updateMany.mock.invocationCallOrder[0]!;
    expect(locked).toBeLessThan(claimed);
    expect(claimed).toBeLessThan(mocks.postAgeUpCreditLot.mock.invocationCallOrder[0]!);
  });

  it("finishes without a lot when another worker claimed the adjustment first", async () => {
    seasonInvoiceOwes(0);
    // The other worker settles the adjustment after this one read it PENDING.
    mocks.lockMemberCreditLedger.mockImplementationOnce(async () => {
      Object.assign(store.adjustment!, { status: "CREDITED_TO_ACCOUNT", memberCreditId: "credit-lot-other" });
    });

    await run();

    expect(mocks.postAgeUpCreditLot).not.toHaveBeenCalled();
    expect(store.adjustment!.memberCreditId).toBe("credit-lot-other");
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(syncOperation, {
      responsePayload: { skipped: true, reason: "claimed-by-another-worker" },
    });
  });
});

describe("creditAgeUpAdjustmentToAccount: the claim (#5190 PR 3)", () => {
  it.each([
    ["is no longer pending", { status: "CREDITED_ON_INVOICE" }],
    ["was voided", { status: "VOIDED" }],
    ["already has a credit lot", { memberCreditId: "credit-lot-other" }],
    ["already has a credit note", { xeroCreditNoteId: "note-1" }],
    ["is a top-up, not a credit", { kind: "TOP_UP" }],
  ] as const)("MUTATION (claim guard): writes no lot for an adjustment that %s", async (_label, state) => {
    Object.assign(store.adjustment!, state);
    const before = { ...store.adjustment! };

    expect(await creditAgeUpAdjustmentToAccount(ADJUSTMENT_ID)).toBeNull();

    expect(mocks.postAgeUpCreditLot).not.toHaveBeenCalled();
    expect(db.memberSubscriptionAgeUpAdjustment.update).not.toHaveBeenCalled();
    expect(store.adjustment).toEqual(before);
  });

  it("writes no lot for an adjustment that does not exist", async () => {
    expect(await creditAgeUpAdjustmentToAccount("adjustment-missing")).toBeNull();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("writes the lot once: a second call finds the adjustment claimed", async () => {
    expect(await creditAgeUpAdjustmentToAccount(ADJUSTMENT_ID)).toEqual({ memberCreditId: "credit-lot-1" });
    expect(await creditAgeUpAdjustmentToAccount(ADJUSTMENT_ID)).toBeNull();
    expect(mocks.postAgeUpCreditLot).toHaveBeenCalledTimes(1);
  });
});

describe("createAgeUpCredit: when it does nothing yet, or at all (#5190 PR 3)", () => {
  it.each([
    ["the season is not billed yet", { status: "NOT_INVOICED", charge: null }],
    ["the season charge has no invoice yet", { status: "UNPAID", charge: { xeroInvoiceId: null, status: "QUEUED" } }],
    ["the season invoice was voided", { status: "UNPAID", charge: { xeroInvoiceId: "inv-season", status: "VOIDED" } }],
  ])("waits, sending nothing, while %s", async (_label, subscription) => {
    store.subscription = subscription;

    const waiting = await run().catch((error: unknown) => error);

    expect(waiting).toBeInstanceOf(XeroAppliedCreditOperationBusyError);
    // The code the outbox scan spaces its re-checks on.
    expect((waiting as XeroAppliedCreditOperationBusyError).waitCode).toBe(AGE_UP_CREDIT_AWAITING_SEASON_INVOICE_CODE);
    expect(mocks.getAuthenticatedXeroClient).not.toHaveBeenCalled();
    expect(mocks.postAgeUpCreditLot).not.toHaveBeenCalled();
    // A wait is not a failure: the outbox returns the row to PENDING itself.
    expect(mocks.failXeroSyncOperation).not.toHaveBeenCalled();
    expect(store.adjustment!.status).toBe("PENDING");
  });

  it.each(["CREDITED_ON_INVOICE", "CREDITED_TO_ACCOUNT", "VOIDED"] as const)(
    "completes as skipped for an adjustment already %s",
    async (status) => {
      store.adjustment!.status = status;

      await run();

      expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(syncOperation, {
        responsePayload: { skipped: true, reason: status },
      });
      expect(mocks.getAuthenticatedXeroClient).not.toHaveBeenCalled();
      expect(mocks.postAgeUpCreditLot).not.toHaveBeenCalled();
    },
  );

  it("fails the operation when its adjustment is a top-up or is gone", async () => {
    store.adjustment!.kind = "TOP_UP";
    await run();
    store.adjustment = null;
    await run();

    expect(mocks.failXeroSyncOperation).toHaveBeenCalledTimes(2);
    expect(mocks.getAuthenticatedXeroClient).not.toHaveBeenCalled();
    expect(mocks.postAgeUpCreditLot).not.toHaveBeenCalled();
  });
});
