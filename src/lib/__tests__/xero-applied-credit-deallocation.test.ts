import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const rows = [
    {
      id: "row-1",
      xeroCreditNoteId: "cn-1",
      amountCents: 4000,
      createdAt: new Date("2026-01-01"),
    },
  ];
  const currentRows = { current: [...rows] };
  const bookingFindUnique = vi.fn();
  const operationFindFirst = vi.fn();
  const operationFindMany = vi.fn();
  const operationPayload = { current: {} as Record<string, unknown> };
  const operationFindUnique = vi.fn(async () => ({
    requestPayload: operationPayload.current,
  }));
  const operationUpdate = vi.fn(async ({ data }: { data: { requestPayload: Record<string, unknown> } }) => {
    operationPayload.current = data.requestPayload;
    return {};
  });
  const allocationFindMany = vi.fn();
  const allocationDelete = vi.fn();
  const allocationUpdate = vi.fn();
  const linkUpdateMany = vi.fn();
  const linkFindMany = vi.fn();
  const linkUpsert = vi.fn();
  const getCreditNote = vi.fn();
  const getInvoice = vi.fn();
  const deleteCreditNoteAllocations = vi.fn();
  const updateContact = vi.fn();
  const createCreditNoteAllocation = vi.fn();
  const complete = vi.fn();
  const fail = vi.fn();
  const deriveApplied = vi.fn();
  const lockLedger = vi.fn();
  const memberFindUnique = vi.fn();
  const containmentFindUnique = vi.fn();
  const containmentUpsert = vi.fn();
  const getContact = vi.fn();

  const tx = {
    $executeRaw: vi.fn(),
    xeroSyncOperation: {
      findMany: operationFindMany,
      findUnique: operationFindUnique,
      update: operationUpdate,
    },
    memberCreditNoteAllocation: {
      findMany: allocationFindMany,
      delete: allocationDelete,
      update: allocationUpdate,
    },
    xeroObjectLink: {
      updateMany: linkUpdateMany,
      findMany: linkFindMany,
      upsert: linkUpsert,
    },
  };
  const prisma = {
    booking: { findUnique: bookingFindUnique },
    /*
      #3034/#3036: deallocation raises an invoice's amount due, so it asks which
      installation this is before it touches Xero. A MISSING
      `environmentSafetySettings` delegate is an UNREADABLE override, which
      resolves UNKNOWN whatever the declaration says — so without this the whole
      suite would test the refusal instead of the deallocation. Declared inline
      rather than imported because `vi.hoisted` runs above this file's imports.
    */
    environmentSafetySettings: { findUnique: vi.fn(async () => null) },
    member: { findUnique: memberFindUnique },
    xeroSandboxContactContainment: {
      findUnique: containmentFindUnique,
      upsert: containmentUpsert,
    },
    xeroSyncOperation: {
      findFirst: operationFindFirst,
      findUnique: operationFindUnique,
      update: operationUpdate,
    },
    memberCreditNoteAllocation: { findMany: allocationFindMany },
    xeroObjectLink: { findMany: linkFindMany },
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  return {
    rows,
    currentRows,
    prisma,
    bookingFindUnique,
    operationFindFirst,
    operationFindMany,
    operationFindUnique,
    operationUpdate,
    operationPayload,
    allocationFindMany,
    allocationDelete,
    allocationUpdate,
    linkUpdateMany,
    linkFindMany,
    linkUpsert,
    getCreditNote,
    deleteCreditNoteAllocations,
    createCreditNoteAllocation,
    complete,
    fail,
    deriveApplied,
    lockLedger,
    memberFindUnique,
    containmentFindUnique,
    containmentUpsert,
    getContact,
    getInvoice,
    updateContact,
    tx,
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/member-credit", () => ({
  deriveBookingAppliedCreditCents: h.deriveApplied,
  lockMemberCreditLedger: h.lockLedger,
}));
vi.mock("@/lib/xero-applied-credit-allocation-repair", () => ({
  repairLegacyAppliedCreditNoteAllocationsForBooking: vi.fn(),
}));
vi.mock("@/lib/xero-api-client", () => ({
  getAuthenticatedXeroClient: vi.fn(async () => ({
    tenantId: "tenant-1",
    xero: {
      accountingApi: {
        getContact: h.getContact,
        updateContact: h.updateContact,
        getInvoice: h.getInvoice,
        getCreditNote: h.getCreditNote,
        deleteCreditNoteAllocations: h.deleteCreditNoteAllocations,
        createCreditNoteAllocation: h.createCreditNoteAllocation,
      },
    },
  })),
  callXeroApi: vi.fn(async (runner: () => unknown) => runner()),
}));
vi.mock("@/lib/xero-sync", () => ({
  buildXeroIdempotencyKey: (...parts: unknown[]) => parts.join(":"),
  completeXeroSyncOperation: h.complete,
  failXeroSyncOperation: h.fail,
  sanitizeForJson: (value: unknown) => value,
  startXeroSyncOperation: vi.fn(),
}));
vi.mock("@/lib/xero-credit-notes", () => ({
  allocateCreditNoteToInvoice: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  deallocateExcessAppliedCreditForBooking,
  planAppliedCreditDeallocation,
} from "@/lib/xero-applied-credit-deallocation";
import { isXeroAppliedCreditOperationBusyError } from "@/lib/xero-applied-credit-operation-serialization";
import { frozenTestNow } from "@/lib/__tests__/helpers/clock";
import { expectClubTimeZonePremise } from "@/lib/__tests__/helpers/club-time-zone";
import {
  declareEnvironmentRole,
  expectEnvironmentRolePremise,
  undeclareEnvironmentRole,
} from "@/lib/__tests__/helpers/environment-role";
import { xeroSandboxContainmentTarget } from "@/lib/xero-sandbox-contact-email";

function providerNote(amountCents: number, allocationID = "alloc-1") {
  return {
    body: {
      creditNotes: [
        {
          allocations:
            amountCents === 0
              ? []
              : [
                  {
                    allocationID,
                    amount: amountCents / 100,
                    invoice: { invoiceID: "inv-1" },
                  },
                ],
        },
      ],
    },
  };
}

function providerNoteMulti(allocations: Array<[number, string]>) {
  return {
    body: {
      creditNotes: [
        {
          allocations: allocations.map(([amountCents, allocationID]) => ({
            allocationID,
            amount: amountCents / 100,
            invoice: { invoiceID: "inv-1" },
          })),
        },
      ],
    },
  };
}

function regularAllocationLink() {
  return {
    id: "link-row-1",
    localModel: "MemberCreditNoteAllocation",
    localId: "row-1",
    xeroObjectId: "cn-1:inv-1:4000",
    role: "APPLIED_CREDIT_ALLOCATION",
    metadata: { creditNoteId: "cn-1", invoiceId: "inv-1", amountCents: 4000 },
  };
}

function remainderAllocationLink() {
  return {
    id: "link-payment-1",
    localModel: "Payment",
    localId: "payment-1",
    xeroObjectId: "cn-1:inv-1:4000",
    role: "APPLIED_CREDIT_REMAINDER_ALLOCATION",
    metadata: { creditNoteId: "cn-1", invoiceId: "inv-1", amountCents: 4000 },
  };
}

describe("deallocateExcessAppliedCreditForBooking (#1887 F3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    /*
      This suite is about the deallocation itself, so it runs as the club's LIVE
      site — where INV-CONFIG-005 is a no-op and every assertion below is about
      unchanged behaviour. The copy and undeclared cases have their own block at
      the end of the file.
    */
    declareEnvironmentRole("production");
    h.memberFindUnique.mockResolvedValue({
      email: "member@example.com",
      xeroContactId: "contact-1",
    });
    h.containmentFindUnique.mockResolvedValue(null);
    h.containmentUpsert.mockResolvedValue({});
    h.getInvoice.mockResolvedValue({
      body: {
        invoices: [{ invoiceID: "inv-1", contact: { contactID: "contact-1" } }],
      },
    });
    h.getContact.mockResolvedValue({
      body: { contacts: [{ contactID: "contact-1", emailAddress: "" }] },
    });
    h.bookingFindUnique.mockResolvedValue({
      id: "booking-1",
      memberId: "member-1",
      payment: {
        id: "payment-1",
        source: "INTERNET_BANKING",
        xeroInvoiceId: "inv-1",
      },
    });
    h.operationFindFirst.mockResolvedValue(null);
    h.operationFindMany.mockResolvedValue([]);
    h.operationPayload.current = {
      queueType: "APPLIED_CREDIT_DEALLOCATION",
      bookingId: "booking-1",
    };
    h.operationFindUnique.mockImplementation(async () => ({
      requestPayload: h.operationPayload.current,
    }));
    h.operationUpdate.mockImplementation(async ({ data }) => {
      h.operationPayload.current = data.requestPayload;
      return {};
    });
    h.deriveApplied.mockResolvedValue(2500);
    h.currentRows.current = h.rows.map((row) => ({ ...row }));
    h.allocationFindMany.mockImplementation(async () => h.currentRows.current);
    h.allocationUpdate.mockImplementation(async ({ where, data }) => {
      h.currentRows.current = h.currentRows.current.map((row) =>
        row.id === where.id ? { ...row, ...data } : row,
      );
      return {};
    });
    h.allocationDelete.mockImplementation(async ({ where }) => {
      h.currentRows.current = h.currentRows.current.filter(
        (row) => row.id !== where.id,
      );
      return {};
    });
    h.linkFindMany.mockResolvedValue([]);
    h.deleteCreditNoteAllocations.mockResolvedValue({
      body: { isDeleted: true },
    });
    h.createCreditNoteAllocation.mockResolvedValue(providerNote(2500));
  });

  it("checkpoints the real allocation ID, deletes, recreates the exact target, then reduces local cents", async () => {
    h.linkFindMany.mockResolvedValue([regularAllocationLink()]);
    h.getCreditNote
      .mockResolvedValueOnce(providerNote(4000))
      .mockResolvedValueOnce(providerNote(2500, "alloc-new"));

    await deallocateExcessAppliedCreditForBooking("booking-1", {
      syncOperationId: "op-1",
    });

    expect(h.operationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "op-1" },
        data: {
          requestPayload: expect.objectContaining({
            ledgerSnapshot: {
              desiredAppliedCents: 2500,
              rows: [{
                id: "row-1",
                xeroCreditNoteId: "cn-1",
                amountCents: 4000,
                createdAt: "2026-01-01T00:00:00.000Z",
              }],
            },
          }),
        },
      }),
    );
    expect(h.deriveApplied).toHaveBeenCalledWith("booking-1", h.tx);
    expect(h.lockLedger.mock.invocationCallOrder[0]).toBeLessThan(
      h.deriveApplied.mock.invocationCallOrder[0],
    );
    expect(h.deriveApplied.mock.invocationCallOrder[0]).toBeLessThan(
      h.operationUpdate.mock.invocationCallOrder[0],
    );
    expect(h.operationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "op-1" },
        data: {
          requestPayload: expect.objectContaining({
            checkpoint: expect.objectContaining({ allocationIds: ["alloc-1"] }),
          }),
        },
      }),
    );
    expect(h.deleteCreditNoteAllocations).toHaveBeenCalledWith(
      "tenant-1",
      "cn-1",
      "alloc-1",
    );
    expect(h.createCreditNoteAllocation).toHaveBeenCalledWith(
      "tenant-1",
      "cn-1",
      { allocations: [expect.objectContaining({ amount: 25 })] },
      undefined,
      "credit-note:cn-1:invoice:inv-1:deallocation-recreate:4000:2500:op:op-1:v2",
    );
    // #2834: the key is derived from the transition, never from a date, so this
    // change cannot make a queued operation miss its dedupe.
    expect(h.createCreditNoteAllocation.mock.calls[0][4]).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(h.allocationUpdate).toHaveBeenCalledWith({
      where: { id: "row-1" },
      data: { amountCents: 2500 },
    });
    expect(h.linkUpdateMany).toHaveBeenCalled();
    expect(h.linkUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          localModel: "MemberCreditNoteAllocation",
          localId: "row-1",
          xeroObjectId: "alloc-new",
          active: true,
          metadata: expect.objectContaining({
            providerAllocationIdVerified: true,
            rowTargetCents: 2500,
          }),
        }),
      })
    );
    expect(h.operationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          requestPayload: expect.objectContaining({
            checkpoint: expect.objectContaining({
              rowTargets: [
                { id: "row-1", currentCents: 4000, targetCents: 2500 },
              ],
              providerAllocations: [
                { allocationID: "alloc-new", amountCents: 2500 },
              ],
              phase: "PROVIDER_VERIFIED",
            }),
          }),
        },
      })
    );
    expect(h.complete).toHaveBeenCalledWith(
      "op-1",
      expect.objectContaining({
        responsePayload: expect.objectContaining({ desiredAppliedCents: 2500 }),
      }),
    );
    expect(h.operationPayload.current).toEqual(
      expect.objectContaining({
        ledgerSnapshot: {
          desiredAppliedCents: 2500,
          rows: [{
            id: "row-1",
            xeroCreditNoteId: "cn-1",
            amountCents: 2500,
            createdAt: "2026-01-01T00:00:00.000Z",
          }],
        },
      }),
    );
  });

  // #2834: the recreated allocation carries a date, and it read the clock's UTC
  // day — still yesterday for roughly the first half of every New Zealand day.
  // Both instants below are chosen so a wrong zone fails them: 00:00 NZST, which
  // any zone shallower than UTC+12 gets wrong, and 00:30 NZDT, which a fixed +12
  // zone with no daylight saving gets wrong.
  describe.each([
    {
      label: "NZST (UTC+12), the first instant of a club day",
      instant: new Date("2026-06-14T12:00:00.000Z"),
      utcDay: "2026-06-14",
      clubDay: "2026-06-15",
    },
    {
      label: "NZDT (UTC+13), 00:30 on a club day",
      instant: new Date("2026-01-14T11:30:00.000Z"),
      utcDay: "2026-01-14",
      clubDay: "2026-01-15",
    },
  ])("the recreated allocation's date — $label", ({ instant, utcDay, clubDay }) => {
    beforeEach(() => {
      // Say what actually happened before any date assertion can turn an
      // environment problem into what looks like the product bug.
      expectClubTimeZonePremise();
      // A fixture that drifted out of the divergence window would pass vacuously.
      expect(instant.toISOString().slice(0, 10)).toBe(utcDay);
      // The root freeze pins midday NZ, where both calendars agree — the one
      // window this defect does not live in.
      vi.setSystemTime(instant);
    });

    afterEach(() => {
      // Hand the clock back so the root `beforeEach` re-freezes the DEFAULT
      // instant for every test declared after this block: `ensureFrozenTestClock()`
      // returns early whenever anything is already mocking `Date`, so it never
      // overwrites — nor restores — a deliberate pin (docs/TESTING.md rule 4).
      vi.useRealTimers();
    });

    it("is the club's calendar day, not the UTC one", async () => {
      h.linkFindMany.mockResolvedValue([regularAllocationLink()]);
      h.getCreditNote
        .mockResolvedValueOnce(providerNote(4000))
        .mockResolvedValueOnce(providerNote(2500, "alloc-new"));

      await deallocateExcessAppliedCreditForBooking("booking-1", {
        syncOperationId: "op-1",
      });

      const [, , body] = h.createCreditNoteAllocation.mock.calls[0];
      expect(body.allocations[0].date).toBe(clubDay);
      expect(body.allocations[0].date).not.toBe(utcDay);
    });
  });

  // The restore proof for the block above. Declared after it, so it runs after
  // it, and it fails the moment that `afterEach` stops handing the clock back —
  // which is all that keeps a scoped pin from silently re-dating every test
  // below to 14 January 2026. `frozenTestNow()` rather than the literal so the
  // rollover canary's `TEST_CLOCK_ISO` / `TEST_CLOCK_OFFSET_DAYS` runs agree.
  it("hands the default frozen clock back to every test declared after the pinned block", () => {
    expect(new Date().toISOString()).toBe(frozenTestNow().toISOString());
  });

  it("scopes the recreate idempotency key to the operation so distinct operations never collide, while a retried operation reuses its key (#1887)", async () => {
    h.linkFindMany.mockResolvedValue([regularAllocationLink()]);

    // Each independent deallocation operation starts from the same durable
    // state (fresh ledger snapshot, provider at currentCents=4000, target=2500)
    // and must nonetheless emit a distinct recreate idempotency key.
    async function recreateKeyFor(syncOperationId: string): Promise<string> {
      h.operationPayload.current = {
        queueType: "APPLIED_CREDIT_DEALLOCATION",
        bookingId: "booking-1",
      };
      h.currentRows.current = h.rows.map((row) => ({ ...row }));
      h.getCreditNote
        .mockReset()
        .mockResolvedValueOnce(providerNote(4000))
        .mockResolvedValueOnce(providerNote(2500, "alloc-new"));
      h.createCreditNoteAllocation.mockClear();
      h.createCreditNoteAllocation.mockResolvedValue(providerNote(2500));

      await deallocateExcessAppliedCreditForBooking("booking-1", {
        syncOperationId,
      });

      const call = h.createCreditNoteAllocation.mock.calls.at(-1);
      expect(call).toBeDefined();
      return call![4] as string;
    }

    const keyOpA = await recreateKeyFor("op-A");
    const keyOpB = await recreateKeyFor("op-B");
    const keyOpARetry = await recreateKeyFor("op-A");

    // Two DISTINCT operations with identical note/invoice/current/target must
    // NOT share a key — otherwise the second op's recreate returns the first
    // op's cached Xero response and creates nothing (under-clearing).
    expect(keyOpA).not.toEqual(keyOpB);
    expect(keyOpA).toContain(":op:op-A:v2");
    expect(keyOpB).toContain(":op:op-B:v2");
    expect(keyOpA).toBe(
      "credit-note:cn-1:invoice:inv-1:deallocation-recreate:4000:2500:op:op-A:v2",
    );

    // The SAME operation retried (crash-retry) must reuse its key so Xero's
    // idempotency dedupes the duplicate recreate.
    expect(keyOpARetry).toBe(keyOpA);
  });

  it("refuses a stale durable ledger snapshot before any provider call", async () => {
    h.operationPayload.current = {
        queueType: "APPLIED_CREDIT_DEALLOCATION",
        bookingId: "booking-1",
        ledgerSnapshot: {
          desiredAppliedCents: 3000,
          rows: [{
            id: "row-1",
            xeroCreditNoteId: "cn-1",
            amountCents: 4000,
            createdAt: "2026-01-01T00:00:00.000Z",
          }],
        },
    };

    await expect(
      deallocateExcessAppliedCreditForBooking("booking-1", {
        syncOperationId: "op-1",
      }),
    ).rejects.toThrow("refusing a stale provider target");
    expect(h.getCreditNote).not.toHaveBeenCalled();
    expect(h.deleteCreditNoteAllocations).not.toHaveBeenCalled();
  });

  it("refuses an ambiguous provider total without deleting anything", async () => {
    h.getCreditNote.mockResolvedValue(providerNote(3500, "manual-or-drifted"));

    await expect(
      deallocateExcessAppliedCreditForBooking("booking-1", {
        syncOperationId: "op-1",
      }),
    ).rejects.toThrow(/Ambiguous Xero allocation total/);

    expect(h.deleteCreditNoteAllocations).not.toHaveBeenCalled();
    expect(h.createCreditNoteAllocation).not.toHaveBeenCalled();
    expect(h.allocationUpdate).not.toHaveBeenCalled();
  });

  it("refuses a same-total provider allocation with no local/checkpoint provenance", async () => {
    h.linkFindMany.mockResolvedValue([]);
    h.getCreditNote.mockResolvedValue(
      providerNote(4000, "manual-same-total-allocation")
    );

    await expect(
      deallocateExcessAppliedCreditForBooking("booking-1", {
        syncOperationId: "op-1",
      })
    ).rejects.toThrow(/Ambiguous Xero allocation total/);

    expect(h.deleteCreditNoteAllocations).not.toHaveBeenCalled();
    expect(h.createCreditNoteAllocation).not.toHaveBeenCalled();
  });

  it("resumes a checkpointed partial delete without guessing", async () => {
    h.linkFindMany.mockResolvedValue([regularAllocationLink()]);
    h.operationPayload.current = {
        queueType: "APPLIED_CREDIT_DEALLOCATION",
        bookingId: "booking-1",
        checkpoint: {
          creditNoteId: "cn-1",
          currentCents: 4000,
          targetCents: 2500,
          allocationIds: ["alloc-deleted", "alloc-remaining"],
        },
    };
    h.getCreditNote
      .mockResolvedValueOnce(providerNote(2000, "alloc-remaining"))
      .mockResolvedValueOnce(providerNote(2500, "alloc-new"));

    await deallocateExcessAppliedCreditForBooking("booking-1", {
      syncOperationId: "op-1",
    });

    expect(h.deleteCreditNoteAllocations).toHaveBeenCalledTimes(1);
    expect(h.deleteCreditNoteAllocations).toHaveBeenCalledWith(
      "tenant-1", "cn-1", "alloc-remaining",
    );
    expect(h.allocationUpdate).toHaveBeenCalledWith({
      where: { id: "row-1" }, data: { amountCents: 2500 },
    });
  });

  it("heals a crash after recreate by linking the verified actual ID without recreating", async () => {
    h.linkFindMany.mockResolvedValue([regularAllocationLink()]);
    h.operationPayload.current = {
        queueType: "APPLIED_CREDIT_DEALLOCATION",
        bookingId: "booking-1",
        checkpoint: {
          creditNoteId: "cn-1",
          currentCents: 4000,
          targetCents: 2500,
          allocationIds: ["alloc-old"],
          phase: "BEFORE_DELETE",
        },
    };
    h.getCreditNote.mockResolvedValue(providerNote(2500, "alloc-recreated"));

    await deallocateExcessAppliedCreditForBooking("booking-1", {
      syncOperationId: "op-1",
    });

    expect(h.deleteCreditNoteAllocations).not.toHaveBeenCalled();
    expect(h.createCreditNoteAllocation).not.toHaveBeenCalled();
    expect(h.allocationUpdate).toHaveBeenCalledWith({
      where: { id: "row-1" }, data: { amountCents: 2500 },
    });
    expect(h.linkUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ xeroObjectId: "alloc-recreated" }),
      })
    );
  });

  it("reconciles a minted-remainder Payment link to the actual replacement ID", async () => {
    h.linkFindMany.mockResolvedValue([remainderAllocationLink()]);
    h.getCreditNote
      .mockResolvedValueOnce(providerNote(4000))
      .mockResolvedValueOnce(providerNote(2500, "alloc-remainder-new"));

    await deallocateExcessAppliedCreditForBooking("booking-1", {
      syncOperationId: "op-1",
    });

    expect(h.linkUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          localModel: "Payment",
          localId: "payment-1",
          role: "APPLIED_CREDIT_REMAINDER_ALLOCATION",
          xeroObjectId: "alloc-remainder-new",
        }),
      })
    );
  });

  it("reconciles multiple local rows on one note to the surviving actual allocation", async () => {
    const rows = [
      { id: "row-1", xeroCreditNoteId: "cn-1", amountCents: 2000, createdAt: new Date("2026-01-01") },
      { id: "row-2", xeroCreditNoteId: "cn-1", amountCents: 2000, createdAt: new Date("2026-02-01") },
    ];
    h.deriveApplied.mockResolvedValue(1500);
    h.allocationFindMany.mockResolvedValue(rows);
    h.linkFindMany.mockResolvedValue([
      {
        ...regularAllocationLink(),
        localId: "row-1",
        id: "link-row-1",
        metadata: { creditNoteId: "cn-1", invoiceId: "inv-1", amountCents: 2000 },
      },
      {
        ...regularAllocationLink(),
        localId: "row-2",
        id: "link-row-2",
        metadata: { creditNoteId: "cn-1", invoiceId: "inv-1", amountCents: 2000 },
      },
    ]);
    h.getCreditNote
      .mockResolvedValueOnce({
        body: {
          creditNotes: [{
            allocations: [
              { allocationID: "alloc-a", amount: 20, invoice: { invoiceID: "inv-1" } },
              { allocationID: "alloc-b", amount: 20, invoice: { invoiceID: "inv-1" } },
            ],
          }],
        },
      })
      .mockResolvedValueOnce(providerNote(1500, "alloc-survivor"));

    await deallocateExcessAppliedCreditForBooking("booking-1", {
      syncOperationId: "op-1",
    });

    expect(h.allocationUpdate).toHaveBeenCalledWith({
      where: { id: "row-1" }, data: { amountCents: 1500 },
    });
    expect(h.allocationDelete).toHaveBeenCalledWith({ where: { id: "row-2" } });
    expect(h.linkUpsert).toHaveBeenCalledTimes(1);
    expect(h.linkUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          localId: "row-1",
          xeroObjectId: "alloc-survivor",
        }),
      })
    );
  });

  it("deactivates regular links and creates none when the target is zero", async () => {
    h.deriveApplied.mockResolvedValue(0);
    h.linkFindMany.mockResolvedValue([regularAllocationLink()]);
    h.getCreditNote
      .mockResolvedValueOnce(providerNote(4000))
      .mockResolvedValueOnce(providerNote(0));

    await deallocateExcessAppliedCreditForBooking("booking-1", {
      syncOperationId: "op-1",
    });

    expect(h.allocationDelete).toHaveBeenCalledWith({ where: { id: "row-1" } });
    expect(h.linkUpdateMany).toHaveBeenCalled();
    expect(h.linkUpsert).not.toHaveBeenCalled();
  });

  it("deactivates a minted-remainder Payment link with no replacement at zero", async () => {
    h.deriveApplied.mockResolvedValue(0);
    h.linkFindMany.mockResolvedValue([remainderAllocationLink()]);
    h.getCreditNote
      .mockResolvedValueOnce(providerNote(4000))
      .mockResolvedValueOnce(providerNote(0));

    await deallocateExcessAppliedCreditForBooking("booking-1", {
      syncOperationId: "op-1",
    });

    expect(h.linkUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({ id: { in: ["link-payment-1"] } }),
          ]),
        }),
      })
    );
    expect(h.linkUpsert).not.toHaveBeenCalled();
  });

  it("persists explicit Xero-read provenance before deleting a same-total legacy/manual ID", async () => {
    h.linkFindMany.mockResolvedValue([regularAllocationLink()]);
    h.getCreditNote
      .mockResolvedValueOnce(providerNote(4000, "actual-id-not-in-legacy-link"))
      .mockResolvedValueOnce(providerNote(2500, "actual-new"));

    await deallocateExcessAppliedCreditForBooking("booking-1", {
      syncOperationId: "op-1",
    });

    expect(h.operationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          requestPayload: expect.objectContaining({
            checkpoint: expect.objectContaining({
              phase: "BEFORE_DELETE",
              providerMatch: "LOCAL_LINK_TOTAL_AND_XERO_NOTE_INVOICE_MATCH",
              allocationIds: ["actual-id-not-in-legacy-link"],
              priorLinks: [expect.objectContaining({ id: "link-row-1" })],
            }),
          }),
        },
      })
    );
  });

  it("requeues (busy) when the post-recreate re-GET is stale under eventual consistency, advances no PROVIDER_VERIFIED checkpoint, and converges on the next run (#1924)", async () => {
    h.linkFindMany.mockResolvedValue([regularAllocationLink()]);
    // Top-of-loop sees the real pre-delete state; the post-recreate re-GET is
    // stale and still lists the just-deleted allocation (recreate not yet
    // visible).
    h.getCreditNote
      .mockResolvedValueOnce(providerNote(4000, "alloc-1"))
      .mockResolvedValueOnce(providerNote(4000, "alloc-1"));

    const busyError = await deallocateExcessAppliedCreditForBooking("booking-1", {
      syncOperationId: "op-1",
    }).catch((err) => err);
    expect(isXeroAppliedCreditOperationBusyError(busyError)).toBe(true);

    // The delete + recreate DID happen this run; the busy classification must
    // add no further provider mutation, advance no PROVIDER_VERIFIED checkpoint,
    // and touch no local ledger.
    expect(h.deleteCreditNoteAllocations).toHaveBeenCalledTimes(1);
    expect(h.createCreditNoteAllocation).toHaveBeenCalledTimes(1);
    expect(h.allocationUpdate).not.toHaveBeenCalled();
    expect(h.linkUpsert).not.toHaveBeenCalled();
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.operationUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          requestPayload: expect.objectContaining({
            checkpoint: expect.objectContaining({ phase: "PROVIDER_VERIFIED" }),
          }),
        },
      }),
    );
    // The durable BEFORE_DELETE checkpoint and a bounded requeue counter persist
    // for the retry; the ledger snapshot is not advanced.
    expect(h.operationPayload.current).toEqual(
      expect.objectContaining({
        eventualConsistencyRequeues: { "cn-1": 1 },
        checkpoint: expect.objectContaining({ phase: "BEFORE_DELETE" }),
      }),
    );

    // Next run: Xero has converged. The BEFORE_DELETE checkpoint proves the
    // provider is already at target, so it links the verified ID and completes.
    h.getCreditNote.mockReset();
    h.getCreditNote.mockResolvedValueOnce(providerNote(2500, "alloc-new"));

    await deallocateExcessAppliedCreditForBooking("booking-1", {
      syncOperationId: "op-1",
    });

    expect(h.deleteCreditNoteAllocations).toHaveBeenCalledTimes(1); // no new delete
    expect(h.createCreditNoteAllocation).toHaveBeenCalledTimes(1); // no new recreate
    expect(h.allocationUpdate).toHaveBeenCalledWith({
      where: { id: "row-1" },
      data: { amountCents: 2500 },
    });
    expect(h.linkUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ xeroObjectId: "alloc-new" }),
      }),
    );
    expect(h.complete).toHaveBeenCalledWith(
      "op-1",
      expect.objectContaining({
        responsePayload: expect.objectContaining({ desiredAppliedCents: 2500 }),
      }),
    );
  });

  it("requeues (busy) when the top-of-loop re-GET still lists the just-deleted allocations alongside the recreate, then converges (#1924)", async () => {
    h.linkFindMany.mockResolvedValue([regularAllocationLink()]);
    // A prior run already issued delete+recreate (durable BEFORE_DELETE
    // checkpoint) but crashed/requeued before local apply. Xero is now stale:
    // the deleted allocation is still visible AND the recreate is visible, so
    // providerTotal (6500) exceeds currentCents and matches none of the three
    // provenance branches.
    h.operationPayload.current = {
      queueType: "APPLIED_CREDIT_DEALLOCATION",
      bookingId: "booking-1",
      ledgerSnapshot: {
        desiredAppliedCents: 2500,
        rows: [
          {
            id: "row-1",
            xeroCreditNoteId: "cn-1",
            amountCents: 4000,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
      checkpoint: {
        creditNoteId: "cn-1",
        currentCents: 4000,
        targetCents: 2500,
        allocationIds: ["alloc-old"],
        providerAllocations: [{ allocationID: "alloc-old", amountCents: 4000 }],
        phase: "BEFORE_DELETE",
      },
    };
    h.getCreditNote.mockResolvedValueOnce(
      providerNoteMulti([
        [4000, "alloc-old"],
        [2500, "alloc-new"],
      ]),
    );

    const topOfLoopBusyError = await deallocateExcessAppliedCreditForBooking(
      "booking-1",
      { syncOperationId: "op-1" },
    ).catch((err) => err);
    expect(isXeroAppliedCreditOperationBusyError(topOfLoopBusyError)).toBe(true);

    // No provider mutation at all — the stale read is classified before any
    // delete/recreate.
    expect(h.deleteCreditNoteAllocations).not.toHaveBeenCalled();
    expect(h.createCreditNoteAllocation).not.toHaveBeenCalled();
    expect(h.allocationUpdate).not.toHaveBeenCalled();
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.operationPayload.current).toEqual(
      expect.objectContaining({ eventualConsistencyRequeues: { "cn-1": 1 } }),
    );

    // Converged retry links the recreate and completes.
    h.getCreditNote.mockReset();
    h.getCreditNote.mockResolvedValueOnce(providerNote(2500, "alloc-new"));

    await deallocateExcessAppliedCreditForBooking("booking-1", {
      syncOperationId: "op-1",
    });

    expect(h.allocationUpdate).toHaveBeenCalledWith({
      where: { id: "row-1" },
      data: { amountCents: 2500 },
    });
    expect(h.complete).toHaveBeenCalled();
  });

  it("stays terminal (not busy) when a foreign allocation makes the post-recreate total unexplainable by eventual consistency (#1924)", async () => {
    h.linkFindMany.mockResolvedValue([regularAllocationLink()]);
    h.getCreditNote
      .mockResolvedValueOnce(providerNote(4000, "alloc-1"))
      // Recreate (alloc-new, 2500) PLUS a foreign allocation (alloc-foreign,
      // 2500) that no checkpoint proves: total 5000 is not a stale projection
      // of the delete+recreate.
      .mockResolvedValueOnce(
        providerNoteMulti([
          [2500, "alloc-new"],
          [2500, "alloc-foreign"],
        ]),
      );

    const error = await deallocateExcessAppliedCreditForBooking("booking-1", {
      syncOperationId: "op-1",
    }).catch((err) => err);

    expect(error).toBeInstanceOf(Error);
    expect(isXeroAppliedCreditOperationBusyError(error)).toBe(false);
    expect((error as Error).message).toMatch(/verification failed/);
    expect(h.operationPayload.current.eventualConsistencyRequeues).toBeUndefined();
  });

  it("lands terminal FAILED once the bounded eventual-consistency requeue cap is exceeded, naming the exhausted note (#1924)", async () => {
    h.linkFindMany.mockResolvedValue([regularAllocationLink()]);
    // Already at the cap (10): the next non-convergence must fail terminal
    // instead of requeuing forever. The counter is stored here as a LEGACY plain
    // number (the pre-per-note format) so this also exercises the back-compat
    // migration rule: a numeric value is treated as the prior count for the note
    // being requeued, so 10 -> 11 still lands terminal.
    h.operationPayload.current = {
      queueType: "APPLIED_CREDIT_DEALLOCATION",
      bookingId: "booking-1",
      eventualConsistencyRequeues: 10,
      ledgerSnapshot: {
        desiredAppliedCents: 2500,
        rows: [
          {
            id: "row-1",
            xeroCreditNoteId: "cn-1",
            amountCents: 4000,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
      checkpoint: {
        creditNoteId: "cn-1",
        currentCents: 4000,
        targetCents: 2500,
        allocationIds: ["alloc-old"],
        providerAllocations: [{ allocationID: "alloc-old", amountCents: 4000 }],
        phase: "BEFORE_DELETE",
      },
    };
    h.getCreditNote.mockResolvedValueOnce(
      providerNoteMulti([
        [4000, "alloc-old"],
        [2500, "alloc-new"],
      ]),
    );

    const error = await deallocateExcessAppliedCreditForBooking("booking-1", {
      syncOperationId: "op-1",
    }).catch((err) => err);

    expect(isXeroAppliedCreditOperationBusyError(error)).toBe(false);
    expect((error as Error).message).toMatch(
      /did not converge after 10 eventual-consistency requeues for credit note cn-1/,
    );
  });

  it("keeps the eventual-consistency requeue budget per credit note so converging notes don't exhaust each other's cap (#1924 review, #1924)", async () => {
    h.linkFindMany.mockResolvedValue([regularAllocationLink()]);
    // cn-2 has already requeued 4 times (converging independently) and cn-1 has
    // requeued 3 times, both well under the cap. A fresh stale top-of-loop read
    // for cn-1 must bump ONLY cn-1's budget (3 -> 4) and stay busy — cn-2's
    // separate count of 4 must not push cn-1 over the shared-in-the-old-design
    // cap and land the operation terminal FAILED spuriously.
    h.operationPayload.current = {
      queueType: "APPLIED_CREDIT_DEALLOCATION",
      bookingId: "booking-1",
      eventualConsistencyRequeues: { "cn-1": 3, "cn-2": 4 },
      ledgerSnapshot: {
        desiredAppliedCents: 2500,
        rows: [
          {
            id: "row-1",
            xeroCreditNoteId: "cn-1",
            amountCents: 4000,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
      checkpoint: {
        creditNoteId: "cn-1",
        currentCents: 4000,
        targetCents: 2500,
        allocationIds: ["alloc-old"],
        providerAllocations: [{ allocationID: "alloc-old", amountCents: 4000 }],
        phase: "BEFORE_DELETE",
      },
    };
    h.getCreditNote.mockResolvedValueOnce(
      providerNoteMulti([
        [4000, "alloc-old"],
        [2500, "alloc-new"],
      ]),
    );

    const busyError = await deallocateExcessAppliedCreditForBooking("booking-1", {
      syncOperationId: "op-1",
    }).catch((err) => err);

    // Under the cap on both notes: transient busy requeue, never terminal.
    expect(isXeroAppliedCreditOperationBusyError(busyError)).toBe(true);
    // Only cn-1 advanced; cn-2's independent budget is untouched.
    expect(h.operationPayload.current.eventualConsistencyRequeues).toEqual({
      "cn-1": 4,
      "cn-2": 4,
    });
  });
});

describe("planAppliedCreditDeallocation", () => {
  it("reduces multiple notes exactly and groups multiple lots on one note", () => {
    const groups = planAppliedCreditDeallocation(
      [
        { id: "old", xeroCreditNoteId: "cn-old", amountCents: 2000, createdAt: new Date("2026-01-01") },
        { id: "new-a", xeroCreditNoteId: "cn-new", amountCents: 1000, createdAt: new Date("2026-02-01") },
        { id: "new-b", xeroCreditNoteId: "cn-new", amountCents: 1000, createdAt: new Date("2026-02-02") },
      ],
      1500,
    );
    expect(groups.map((group) => ({ note: group.xeroCreditNoteId, target: group.targetCents })))
      .toEqual([{ note: "cn-old", target: 1500 }, { note: "cn-new", target: 0 }]);
    expect(groups[1].rowTargets).toEqual([
      { id: "new-a", currentCents: 1000, targetCents: 0 },
      { id: "new-b", currentCents: 1000, targetCents: 0 },
    ]);
  });
});

/**
 * INV-CONFIG-005 (#3036 review P0-2). Deallocation REMOVES credit from an
 * invoice, so it raises what is outstanding on it — and Xero emails reminders
 * for an outstanding AUTHORISED invoice to the address on its contact, from its
 * own servers, with no API call from this application. This path never touches
 * `findOrCreateXeroContact`, so on a copy restored from the club's live database
 * nothing here had ever looked at what that contact holds.
 */
describe("deallocation on a copy contains the contact first (INV-CONFIG-005)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    h.memberFindUnique.mockResolvedValue({
      email: "member@example.com",
      xeroContactId: "contact-1",
    });
    h.containmentFindUnique.mockResolvedValue(null);
    h.containmentUpsert.mockResolvedValue({});
    h.getInvoice.mockResolvedValue({
      body: {
        invoices: [{ invoiceID: "inv-1", contact: { contactID: "contact-1" } }],
      },
    });
    h.bookingFindUnique.mockResolvedValue({
      id: "booking-1",
      memberId: "member-1",
      payment: {
        id: "payment-1",
        source: "INTERNET_BANKING",
        xeroInvoiceId: "inv-1",
      },
    });
    h.operationFindFirst.mockResolvedValue(null);
    h.operationFindMany.mockResolvedValue([]);
    h.operationPayload.current = {
      queueType: "APPLIED_CREDIT_DEALLOCATION",
      bookingId: "booking-1",
    };
    h.deriveApplied.mockResolvedValue(2500);
    h.currentRows.current = h.rows.map((row) => ({ ...row }));
    h.allocationFindMany.mockImplementation(async () => h.currentRows.current);
    h.linkFindMany.mockResolvedValue([]);
  });

  it("rewrites the contact's real address before it touches the allocation", async () => {
    declareEnvironmentRole("non-production");
    await expectEnvironmentRolePremise("NON_PRODUCTION");
    h.getContact.mockResolvedValue({
      body: {
        contacts: [
          { contactID: "contact-1", emailAddress: "member@example.com" },
        ],
      },
    });
    h.linkFindMany.mockResolvedValue([regularAllocationLink()]);
    h.updateContact.mockResolvedValue({ body: {} });
    h.getCreditNote
      .mockResolvedValueOnce(providerNote(4000))
      .mockResolvedValueOnce(providerNote(2500, "alloc-new"));
    h.deleteCreditNoteAllocations.mockResolvedValue({ body: { isDeleted: true } });
    h.createCreditNoteAllocation.mockResolvedValue(providerNote(2500));

    await deallocateExcessAppliedCreditForBooking("booking-1", {
      syncOperationId: "op-1",
    });

    expect(h.getContact).toHaveBeenCalledWith("tenant-1", "contact-1");
    expect(h.updateContact).toHaveBeenCalledTimes(1);
    expect(h.containmentUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { xeroContactId: "contact-1" },
        create: expect.objectContaining({
          containedEmail: xeroSandboxContainmentTarget("member@example.com"),
          rewroteAddress: true,
        }),
      }),
    );
  });

  it("refuses, and deletes no allocation, when containment cannot be proved", async () => {
    declareEnvironmentRole("non-production");
    await expectEnvironmentRolePremise("NON_PRODUCTION");
    h.getContact.mockRejectedValue(new Error("503 from Xero"));

    await expect(
      deallocateExcessAppliedCreditForBooking("booking-1", {
        syncOperationId: "op-1",
      }),
    ).rejects.toThrow(/cannot prove the contact is unable to reach a member/);
    expect(h.deleteCreditNoteAllocations).not.toHaveBeenCalled();
    expect(h.allocationDelete).not.toHaveBeenCalled();
    // And the local ledger was never locked, so a refusal costs no contention.
    expect(h.lockLedger).not.toHaveBeenCalled();
  });

  it("refuses on a copy where the INVOICE names no contact", async () => {
    /*
      The contact this operation is about is the invoice's, not the member's —
      those differ after a merge or an admin re-link, and containing the member's
      would prove nothing about the invoice whose amount due this raises. So the
      refusal is keyed on the invoice having no contact, and the member's link is
      irrelevant to it (it is set here, and the call still refuses).
    */
    declareEnvironmentRole("non-production");
    await expectEnvironmentRolePremise("NON_PRODUCTION");
    h.getInvoice.mockResolvedValue({
      body: { invoices: [{ invoiceID: "inv-1", contact: undefined }] },
    });

    await expect(
      deallocateExcessAppliedCreditForBooking("booking-1", {
        syncOperationId: "op-1",
      }),
    ).rejects.toThrow(/cannot be identified from here/);
    expect(h.deleteCreditNoteAllocations).not.toHaveBeenCalled();
  });

  it("contains the INVOICE's contact, not the member's, when the two differ", async () => {
    /*
      The permissive defect this replaced: `Member.xeroContactId` is a different
      contact from the invoice's after a member merge (which nulls the loser's
      link while the loser's invoices keep the loser's contact) or an admin
      re-link. Containing the member's link and then raising the amount due on an
      invoice belonging to another contact left that contact holding a real
      address for Xero to remind about.
    */
    declareEnvironmentRole("non-production");
    await expectEnvironmentRolePremise("NON_PRODUCTION");
    h.memberFindUnique.mockResolvedValue({
      email: "member@example.com",
      xeroContactId: "contact-survivor",
    });
    h.getInvoice.mockResolvedValue({
      body: {
        invoices: [
          { invoiceID: "inv-1", contact: { contactID: "contact-loser" } },
        ],
      },
    });
    h.getContact.mockResolvedValue({
      body: {
        contacts: [
          { contactID: "contact-loser", emailAddress: "member@example.com" },
        ],
      },
    });
    h.updateContact.mockResolvedValue({ body: {} });
    h.linkFindMany.mockResolvedValue([regularAllocationLink()]);
    h.getCreditNote
      .mockResolvedValueOnce(providerNote(4000))
      .mockResolvedValueOnce(providerNote(2500, "alloc-new"));
    h.deleteCreditNoteAllocations.mockResolvedValue({ body: { isDeleted: true } });
    h.createCreditNoteAllocation.mockResolvedValue(providerNote(2500));

    await deallocateExcessAppliedCreditForBooking("booking-1", {
      syncOperationId: "op-1",
    });

    expect(h.getContact).toHaveBeenCalledWith("tenant-1", "contact-loser");
    expect(h.containmentUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { xeroContactId: "contact-loser" },
      }),
    );
  });

  it("refuses on an installation that has declared nothing", async () => {
    undeclareEnvironmentRole();
    await expectEnvironmentRolePremise("UNKNOWN");
    await expect(
      deallocateExcessAppliedCreditForBooking("booking-1", {
        syncOperationId: "op-1",
      }),
    ).rejects.toThrow(/APP_ENVIRONMENT_ROLE/);
    expect(h.deleteCreditNoteAllocations).not.toHaveBeenCalled();
    expect(h.lockLedger).not.toHaveBeenCalled();
  });

  it("does none of that on the club's live site", async () => {
    declareEnvironmentRole("production");
    await expectEnvironmentRolePremise("PRODUCTION");
    h.linkFindMany.mockResolvedValue([regularAllocationLink()]);
    h.getCreditNote
      .mockResolvedValueOnce(providerNote(4000))
      .mockResolvedValueOnce(providerNote(2500, "alloc-new"));
    h.deleteCreditNoteAllocations.mockResolvedValue({ body: { isDeleted: true } });
    h.createCreditNoteAllocation.mockResolvedValue(providerNote(2500));

    await deallocateExcessAppliedCreditForBooking("booking-1", {
      syncOperationId: "op-1",
    });

    expect(h.getContact).not.toHaveBeenCalled();
    expect(h.containmentFindUnique).not.toHaveBeenCalled();
    expect(h.containmentUpsert).not.toHaveBeenCalled();
    // Not even the member row is read: the policy answers first.
    expect(h.memberFindUnique).not.toHaveBeenCalled();
    /*
      AND NOT THE INVOICE EITHER. The contact is supplied as a FUNCTION precisely
      so this read is never spent on the club's live site, where the whole check
      is a no-op. A value would have cost every production deallocation a provider
      round trip to answer a question production does not ask.
    */
    expect(h.getInvoice).not.toHaveBeenCalled();
  });
});
