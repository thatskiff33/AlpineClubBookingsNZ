import { beforeEach, describe, expect, it, vi } from "vitest";
import { BookingStatus, GroupBookingStatus } from "@prisma/client";

const mocks = vi.hoisted(() => {
  const settlementFindUnique = vi.fn();
  const settlementUpdate = vi.fn();
  /*
    #3071: the transaction client carries the environment-safety delegate,
    because the invoice-email policy is re-read on `tx` inside
    `pg_advisory_xact_lock(1)` immediately before the provider call. Reading on
    the transaction client is what makes that re-read cost no second Prisma
    connection, which was the stated objection to re-reading at all.

    It is a SEPARATE mock from the global client's, which is what lets a test
    prove the read goes through the transaction rather than around it: give the
    two different answers and see which one the code obeys.
  */
  const txEnvironmentSafetyFindUnique = vi.fn();
  /*
    #3642: the fenced reads now also decide whether the settlement is still
    BOUND to an Internet Banking invoice, and whether it still points at the
    invoice just created. The row a fence reads is therefore modelled like the
    database: an Internet Banking settlement awaiting its invoice unless the
    test says otherwise, with whatever the post-create update persisted laid
    over it (reset per test).
  */
  const persisted: { current: Record<string, unknown> } = { current: {} };
  const opCorrelationKey: { current: string | null } = { current: null };
  const createRowKeys: { current: string[] } = { current: [] };
  const tx = {
    $executeRaw: vi.fn(),
    environmentSafetySettings: { findUnique: txEnvironmentSafetyFindUnique },
    groupBookingSettlement: {
      findUnique: vi.fn(async (args: unknown) => {
        const row = await settlementFindUnique(args);
        return row
          ? {
              source: "INTERNET_BANKING",
              status: "PENDING",
              amountCents: 4500,
              xeroInvoiceId: null,
              ...row,
              ...persisted.current,
            }
          : row;
      }),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        persisted.current = { ...persisted.current, ...args.data };
        return settlementUpdate(args);
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    /*
      #3642: which attempt the worker's row is (its correlation key) and every
      attempt the settlement has asked for (the CREATE rows' keys).
    */
    xeroSyncOperation: {
      findUnique: vi.fn(async () => ({ correlationKey: opCorrelationKey.current })),
      findMany: vi.fn(async () =>
        createRowKeys.current.map((correlationKey) => ({ correlationKey }))
      ),
    },
  };
  const accountingApi = {
    createInvoices: vi.fn(),
    updateInvoice: vi.fn(),
    emailInvoice: vi.fn(),
    getInvoice: vi.fn(),
  };
  return {
    tx,
    persisted,
    opCorrelationKey,
    createRowKeys,
    alert: vi.fn(),
    txEnvironmentSafetyFindUnique,
    globalEnvironmentSafetyFindUnique: vi.fn(),
    settlementFindUnique,
    settlementUpdate,
    accountingApi,
    completeSync: vi.fn(),
    // #3035: the withheld-send audit row. Exposed so a test can assert that an
    // environment-safety withhold writes NO such row — that row asserts an
    // administrator turned the booking's "No emails" switch on.
    emailLogCreate: vi.fn().mockResolvedValue({ id: "emaillog_1" }),
    failSync: vi.fn(),
    upsertLink: vi.fn(),
    enqueueVoid: vi.fn(),
    enqueueAbandonVoid: vi.fn(),
    transaction: vi.fn(),
    transactionDepth: 0,
  };
});

vi.mock("xero-node", () => ({
  Invoice: {
    TypeEnum: { ACCREC: "ACCREC" },
    StatusEnum: { AUTHORISED: "AUTHORISED", VOIDED: "VOIDED" },
  },
  LineAmountTypes: { Inclusive: "Inclusive" },
  LineItem: class {},
  RequestEmpty: class {},
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    environmentSafetySettings: {
      findUnique: mocks.globalEnvironmentSafetyFindUnique,
    },
    $transaction: mocks.transaction,
    groupBookingSettlement: {
      update: mocks.settlementUpdate,
      findUnique: mocks.settlementFindUnique,
    },
    booking: { findMany: vi.fn() },
    // #2258: the withheld-send audit row for the organiser's settlement invoice.
    emailLog: { create: mocks.emailLogCreate },
    season: { findFirst: vi.fn().mockResolvedValue(null) },
    xeroSyncOperation: { update: vi.fn() },
  },
}));

vi.mock("@/lib/xero-api-client", () => ({
  getAuthenticatedXeroClient: vi.fn().mockResolvedValue({
    xero: { accountingApi: mocks.accountingApi },
    tenantId: "tenant-1",
  }),
  callXeroApi: vi.fn(async (callback) => callback()),
}));

vi.mock("@/lib/xero-contacts", () => ({
  findOrCreateXeroContact: vi.fn().mockResolvedValue("contact-1"),
  retryXeroWriteWithContactRepair: vi.fn(async ({ currentContactId, run }) =>
    run({ contactId: currentContactId })
  ),
}));

// Partial: `getHutFeeSeasonType` stays real (#3530 moved the lodge-scoped
// season read there), so the lodge-scope assertion below still reads the query
// this builder actually issues through the mocked prisma.
vi.mock("@/lib/xero-mappings", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-mappings")),
  getResolvedAccountMapping: vi.fn().mockResolvedValue({
    code: "200",
    itemCode: null,
    codeExplicitlyConfigured: true,
  }),
  getHutFeeItemCodeMap: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("@/lib/xero-booking-invoices", () => ({
  // One $45 line: the child's stay, priced to its final price below.
  buildInvoiceLineItems: vi.fn(() => [
    { description: "One lodge stay", unitAmount: 45, quantity: 1 },
  ]),
}));

vi.mock("@/lib/xero-sync", () => ({
  buildXeroIdempotencyKey: vi.fn((...parts: string[]) => parts.join(":")),
  completeXeroSyncOperation: mocks.completeSync,
  failXeroSyncOperation: mocks.failSync,
  sanitizeForJson: vi.fn((value) => value),
  startXeroSyncOperation: vi.fn(),
  upsertXeroObjectLink: mocks.upsertLink,
}));

vi.mock("@/lib/xero-links", () => ({
  buildXeroInvoiceUrl: vi.fn((id: string) => `https://xero.test/${id}`),
}));

vi.mock("@/lib/pricing", () => ({
  getStayNights: vi.fn(() => [new Date("2026-07-01")]),
}));

vi.mock("@/lib/logger", () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/group-settlement-invoice-alerts", () => ({
  alertGroupSettlementInvoice: mocks.alert,
}));
vi.mock("@/lib/club-format-server", async () => ({
  clubFormatValues: vi.fn(
    async () => (await import("./support/club-format-fixture")).CLUB_FORMAT_TEST
  ),
}));
vi.mock("@/lib/xero-group-settlement-void-outbox", () => ({
  enqueueXeroGroupSettlementInvoiceVoidOperation: mocks.enqueueVoid,
  enqueueXeroGroupSettlementInvoiceAbandonVoidOperation: mocks.enqueueAbandonVoid,
}));

import { prisma } from "@/lib/prisma";
import { declareEnvironmentRole } from "@/lib/__tests__/helpers/environment-role";
import { createXeroInvoiceForGroupSettlement } from "@/lib/xero-group-settlement-invoices";
import {
  voidXeroInvoiceForAbandonedGroupSettlement,
  voidXeroInvoiceForCancelledGroupSettlement,
} from "@/lib/xero-group-settlement-invoice-voids";

function settlement(status: GroupBookingStatus) {
  return {
    id: "settle-1",
    createdAt: new Date("2026-06-01"),
    // #3642: an Internet Banking settlement still waiting on its invoice.
    source: "INTERNET_BANKING",
    status: "PENDING",
    amountCents: 4500,
    xeroInvoiceId: null,
    xeroInvoiceNumber: null,
    groupBooking: {
      id: "group-1",
      status,
      organiserMemberId: "member-1",
      organiserBookingId: "organiser-booking-1",
      organiserBooking: {
        checkIn: new Date("2026-07-01"),
        // #2258: the pre-email fence re-reads the ORGANISER'S booking switch.
        noEmails: false,
        member: { email: "organiser@example.test" },
      },
    },
  };
}

function settlementWithInvoice(status: GroupBookingStatus) {
  return {
    ...settlement(status),
    xeroInvoiceId: "inv-existing",
    xeroInvoiceNumber: "INV-EXISTING",
  };
}

/*
  #3035 (ENV-SAFETY 2): asking Xero to email an invoice is a provider SEND, so it
  now goes through the environment-safety boundary. Both halves of the role have
  to be declared or it resolves UNKNOWN and no invoice is emailed — a missing
  `environmentSafetySettings` delegate is an UNREADABLE override, not "no
  override". See src/lib/__tests__/helpers/environment-role.ts.
*/
beforeEach(() => {
  declareEnvironmentRole("production");
  // No override on either client: the ordinary state of an installation that has
  // never used the safer switch. `vi.clearAllMocks()` clears calls, not
  // implementations, so these survive into every test below.
  mocks.globalEnvironmentSafetyFindUnique.mockResolvedValue(null);
  mocks.txEnvironmentSafetyFindUnique.mockResolvedValue(null);
});

describe("createXeroInvoiceForGroupSettlement cancellation fence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tx.$executeRaw.mockResolvedValue(undefined);
    mocks.transaction.mockImplementation(async (callback) => {
      mocks.transactionDepth += 1;
      try {
        return await callback(mocks.tx);
      } finally {
        mocks.transactionDepth -= 1;
      }
    });
    mocks.settlementUpdate.mockResolvedValue({});
    mocks.persisted.current = {};
    mocks.opCorrelationKey.current = null;
    mocks.createRowKeys.current = [];
    mocks.accountingApi.getInvoice.mockResolvedValue({
      body: { invoices: [{ invoiceID: "inv-existing", status: "AUTHORISED", amountPaid: 0 }] },
    });
    mocks.enqueueVoid.mockResolvedValue({ queueOperationId: "void-op-1" });
    vi.mocked(prisma.booking.findMany).mockResolvedValue([
      {
        id: "child-1",
        status: BookingStatus.CONFIRMED,
        // Booking.lodgeId is NOT NULL; the per-child season read that picks the
        // hut-fee item code is scoped to it.
        lodgeId: "lodge-1",
        checkIn: new Date("2026-07-01"),
        checkOut: new Date("2026-07-02"),
        finalPriceCents: 4500,
        promoAdjustmentCents: 0,
        promoRedemption: null,
        guests: [],
      } as never,
    ]);
    mocks.accountingApi.createInvoices.mockResolvedValue({
      body: { invoices: [{ invoiceID: "inv-1", invoiceNumber: "INV-1", total: 45 }] },
    });
    mocks.accountingApi.updateInvoice.mockResolvedValue({
      body: { invoices: [{ invoiceID: "inv-1", status: "VOIDED" }] },
    });
  });

  it("does no provider work when cancellation committed before the worker starts", async () => {
    mocks.settlementFindUnique.mockResolvedValue(
      settlement(GroupBookingStatus.CANCELLED)
    );

    await expect(
      createXeroInvoiceForGroupSettlement("settle-1", {
        syncOperationId: "op-1",
      })
    ).resolves.toBeNull();

    expect(mocks.accountingApi.createInvoices).not.toHaveBeenCalled();
    expect(mocks.enqueueVoid).not.toHaveBeenCalled();
    expect(mocks.accountingApi.emailInvoice).not.toHaveBeenCalled();
    expect(mocks.completeSync).toHaveBeenCalledWith(
      "op-1",
      expect.objectContaining({
        status: "SUCCEEDED",
        responsePayload: { cancelledBeforeInvoiceCreation: true },
      })
    );
  });

  it("retries durable compensation when a cancelled settlement already has an invoice", async () => {
    mocks.settlementFindUnique.mockResolvedValue(
      settlementWithInvoice(GroupBookingStatus.CANCELLED)
    );

    await expect(
      createXeroInvoiceForGroupSettlement("settle-1", {
        syncOperationId: "op-1",
      })
    ).resolves.toBeNull();

    expect(mocks.accountingApi.createInvoices).not.toHaveBeenCalled();
    expect(mocks.enqueueVoid).toHaveBeenCalledWith("settle-1", {
      store: mocks.tx,
    });
    expect(mocks.accountingApi.updateInvoice).toHaveBeenCalledWith(
      "tenant-1",
      "inv-existing",
      { invoices: [{ invoiceID: "inv-existing", status: "VOIDED" }] },
      undefined,
      "group-settlement:settle-1:invoice-void-after-cancel:inv-existing:v1"
    );
    expect(mocks.accountingApi.emailInvoice).not.toHaveBeenCalled();
    expect(mocks.completeSync).toHaveBeenCalledWith(
      "op-1",
      expect.objectContaining({
        status: "SUCCEEDED",
        responsePayload: expect.objectContaining({
          cancelledAfterInvoiceCreation: true,
          invoiceEmailSuppressed: true,
        }),
      })
    );
  });

  it("voids and suppresses email when cancellation wins while createInvoices is in flight", async () => {
    mocks.settlementFindUnique
      .mockResolvedValueOnce(settlement(GroupBookingStatus.OPEN))
      .mockResolvedValueOnce({
        groupBooking: {
          status: GroupBookingStatus.CANCELLED,
          organiserBookingId: "organiser-booking-1",
          organiserBooking: {
            noEmails: false,
            member: { email: "organiser@example.test" },
          },
        },
      });

    await expect(
      createXeroInvoiceForGroupSettlement("settle-1", {
        syncOperationId: "op-1",
      })
    ).resolves.toBeNull();

    expect(mocks.settlementUpdate).toHaveBeenCalledWith({
      where: { id: "settle-1" },
      data: { xeroInvoiceId: "inv-1", xeroInvoiceNumber: "INV-1" },
    });
    expect(mocks.accountingApi.updateInvoice).toHaveBeenCalledWith(
      "tenant-1",
      "inv-1",
      { invoices: [{ invoiceID: "inv-1", status: "VOIDED" }] },
      undefined,
      "group-settlement:settle-1:invoice-void-after-cancel:inv-1:v1"
    );
    expect(mocks.accountingApi.emailInvoice).not.toHaveBeenCalled();
    expect(mocks.completeSync).toHaveBeenCalledWith(
      "op-1",
      expect.objectContaining({
        status: "SUCCEEDED",
        responsePayload: expect.objectContaining({
          cancelledAfterInvoiceCreation: true,
          invoiceEmailSuppressed: true,
        }),
      })
    );
  });

  it("replays the durable VOID handler idempotently with the stable provider key", async () => {
    mocks.settlementFindUnique.mockResolvedValue(
      settlementWithInvoice(GroupBookingStatus.CANCELLED)
    );

    await voidXeroInvoiceForCancelledGroupSettlement("settle-1", {
      syncOperationId: "void-op-1",
    });
    await voidXeroInvoiceForCancelledGroupSettlement("settle-1", {
      syncOperationId: "void-op-2",
    });

    expect(mocks.accountingApi.updateInvoice).toHaveBeenCalledTimes(2);
    for (const call of mocks.accountingApi.updateInvoice.mock.calls) {
      expect(call[4]).toBe(
        "group-settlement:settle-1:invoice-void-after-cancel:inv-existing:v1"
      );
    }
    expect(mocks.completeSync).toHaveBeenCalledWith(
      "void-op-2",
      expect.objectContaining({ status: "SUCCEEDED" })
    );
  });

  it("propagates a durable VOID failure so the outbox retry machinery can re-drive it", async () => {
    mocks.settlementFindUnique.mockResolvedValue(
      settlementWithInvoice(GroupBookingStatus.CANCELLED)
    );
    mocks.accountingApi.updateInvoice.mockRejectedValueOnce(
      new Error("Xero unavailable")
    );

    await expect(
      voidXeroInvoiceForCancelledGroupSettlement("settle-1", {
        syncOperationId: "void-op-1",
      })
    ).rejects.toThrow("Xero unavailable");
    expect(mocks.completeSync).not.toHaveBeenCalled();
  });

  it("holds the lifecycle fence for the single bounded invoice email call", async () => {
    mocks.settlementFindUnique
      .mockResolvedValueOnce(settlement(GroupBookingStatus.OPEN))
      .mockResolvedValueOnce({
        groupBooking: {
          status: GroupBookingStatus.OPEN,
          organiserBookingId: "organiser-booking-1",
          organiserBooking: {
            noEmails: false,
            member: { email: "organiser@example.test" },
          },
        },
      })
      .mockResolvedValueOnce({
        groupBooking: {
          status: GroupBookingStatus.OPEN,
          organiserBookingId: "organiser-booking-1",
          organiserBooking: {
            noEmails: false,
            member: { email: "organiser@example.test" },
          },
        },
      });
    mocks.accountingApi.emailInvoice.mockImplementation(async () => {
      expect(mocks.transactionDepth).toBe(1);
      return { body: { sent: true } };
    });

    await expect(
      createXeroInvoiceForGroupSettlement("settle-1", {
        syncOperationId: "op-1",
      })
    ).resolves.toBe("inv-1");

    expect(mocks.accountingApi.emailInvoice).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueVoid).not.toHaveBeenCalled();
  });

  /*
    #3035 (ENV-SAFETY 2, INV-CONFIG-004). The invoice is still RAISED — it has to
    be, so settlement stays testable on a copy and #3036 can keep it AUTHORISED —
    and only the emailing is withheld.
  */
  describe("the environment-safety boundary", () => {
    function organiserFence() {
      return {
        groupBooking: {
          status: GroupBookingStatus.OPEN,
          organiserBookingId: "organiser-booking-1",
          organiserBooking: {
            noEmails: false,
            member: { email: "organiser@example.test" },
          },
        },
      };
    }

    beforeEach(() => {
      mocks.settlementFindUnique
        .mockResolvedValueOnce(settlement(GroupBookingStatus.OPEN))
        .mockResolvedValueOnce(organiserFence())
        .mockResolvedValueOnce(organiserFence());
    });

    it("raises the invoice but emails nobody on a confirmed copy, and reports SUCCEEDED", async () => {
      declareEnvironmentRole("non-production");

      await expect(
        createXeroInvoiceForGroupSettlement("settle-1", {
          syncOperationId: "op-1",
        })
      ).resolves.toBe("inv-1");

      expect(mocks.accountingApi.emailInvoice).not.toHaveBeenCalled();
      const completion = mocks.completeSync.mock.calls.at(-1)?.[1];
      // Nothing FAILED, so nothing may be reported as a failure. A staging run
      // that reported PARTIAL on every invoice would train an operator to ignore
      // PARTIAL.
      expect(completion.status).toBe("SUCCEEDED");
      expect(completion.responsePayload.invoiceEmailError).toBeNull();
      expect(
        completion.responsePayload.invoiceEmailWithheldForEnvironment
      ).toBe(true);
      // NOT the organiser's own "No emails" decision, and no withheld-email
      // audit row claiming an administrator made one.
      expect(
        completion.responsePayload.invoiceEmailWithheldByNoEmails
      ).toBe(false);
      expect(mocks.emailLogCreate).not.toHaveBeenCalled();
    });

    it("reports PARTIAL when nobody has said what this installation is", async () => {
      vi.stubEnv("APP_ENVIRONMENT_ROLE", "");

      await expect(
        createXeroInvoiceForGroupSettlement("settle-1", {
          syncOperationId: "op-1",
        })
      ).resolves.toBe("inv-1");

      expect(mocks.accountingApi.emailInvoice).not.toHaveBeenCalled();
      const completion = mocks.completeSync.mock.calls.at(-1)?.[1];
      expect(completion.status).toBe("PARTIAL");
      expect(completion.responsePayload.invoiceEmailError).toBeTruthy();
      expect(
        completion.responsePayload.invoiceEmailWithheldForEnvironment
      ).toBe(false);
      expect(mocks.emailLogCreate).not.toHaveBeenCalled();
    });

    /*
      #3071 external review. The clearance was minted BEFORE the transaction
      opened, and the transaction's first act is `pg_advisory_xact_lock(1)` — an
      exclusive lock every other invoice run is queued on, so the wait has no
      bound. The send then went ahead behind a witness-only check, which proves
      the token was genuine and says nothing about whether it is still true.

      So an administrator who switched the safer override on while this workflow
      was queued for the lock had their click ignored, and the invoice was emailed
      to a real member on a copy.

      The fix re-reads on the TRANSACTION client. That was the whole difficulty:
      the original code deliberately did not re-resolve because a second Prisma
      CONNECTION taken from inside that lock is a genuine pool-timeout hazard. A
      read on `tx` uses the connection the transaction already holds.
    */
    it("refuses the send when the override is switched on during the lock wait", async () => {
      // Before the lock: nothing has been switched on, so the outer policy is a
      // clean allow and a clearance is minted.
      mocks.globalEnvironmentSafetyFindUnique.mockResolvedValue(null);
      // While queued for lock(1): an administrator switches the safer override
      // on. Only the in-transaction read can see this.
      mocks.txEnvironmentSafetyFindUnique.mockResolvedValue({
        forceNonProduction: true,
        updatedAt: new Date("2026-07-01T00:00:00.000Z"),
        updatedByMemberId: "member-admin",
      });

      await expect(
        createXeroInvoiceForGroupSettlement("settle-1", {
          syncOperationId: "op-1",
        })
      ).resolves.toBe("inv-1");

      // The provider is never asked, which is the whole point.
      expect(mocks.accountingApi.emailInvoice).not.toHaveBeenCalled();

      // AND THE READ REALLY WENT THROUGH THE TRANSACTION. Without this the test
      // would pass just as well if the code had re-read on the global client,
      // which is the thing that would take a second connection inside the lock.
      expect(mocks.txEnvironmentSafetyFindUnique).toHaveBeenCalled();

      // The invoice still exists and is untouched: only the emailing is withheld,
      // and a copy withholding is not a failure.
      const completion = mocks.completeSync.mock.calls.at(-1)?.[1];
      expect(completion.status).toBe("SUCCEEDED");
      expect(completion.responsePayload.invoiceEmailError).toBeNull();
      expect(
        completion.responsePayload.invoiceEmailWithheldForEnvironment
      ).toBe(true);
      // Recorded from what the GATE did, never from the outer policy, so two
      // withhold reasons never both claim one event (#3035 review).
      expect(
        completion.responsePayload.invoiceEmailWithheldByNoEmails
      ).toBe(false);
      expect(mocks.emailLogCreate).not.toHaveBeenCalled();
    });

    it("still emails when nothing changed during the lock wait", async () => {
      // The counterpart, so the re-read cannot become an unconditional refusal.
      // A guard that withheld everything would pass the test above and break
      // every settlement invoice on the club's live site.
      mocks.globalEnvironmentSafetyFindUnique.mockResolvedValue(null);
      mocks.txEnvironmentSafetyFindUnique.mockResolvedValue(null);

      await expect(
        createXeroInvoiceForGroupSettlement("settle-1", {
          syncOperationId: "op-1",
        })
      ).resolves.toBe("inv-1");

      expect(mocks.accountingApi.emailInvoice).toHaveBeenCalledTimes(1);
      expect(mocks.txEnvironmentSafetyFindUnique).toHaveBeenCalled();
    });

    it("does not spend a second read when the outer answer was already a withhold", async () => {
      /*
        A confirmed copy is decided before the lock is taken, and re-asking could
        only confirm it: the override is one-directional, so the answer can never
        become MORE permissive. Asking anyway would spend a read inside an
        exclusive lock to change nothing.
      */
      declareEnvironmentRole("non-production");

      await expect(
        createXeroInvoiceForGroupSettlement("settle-1", {
          syncOperationId: "op-1",
        })
      ).resolves.toBe("inv-1");

      expect(mocks.accountingApi.emailInvoice).not.toHaveBeenCalled();
      expect(mocks.txEnvironmentSafetyFindUnique).not.toHaveBeenCalled();
    });
  });

  /*
    #3035 review: TWO WITHHOLD REASONS MUST NEVER BOTH CLAIM THE SAME EVENT.

    The environment withhold used to be computed from the policy alone, outside
    the advisory-locked transaction, and written into the payload
    unconditionally — while the transaction checks the organiser's own "No emails"
    switch FIRST. So on a copy whose organiser has that switch on, the payload
    asserted `invoiceEmailWithheldByNoEmails: true` AND
    `invoiceEmailWithheldForEnvironment: true`, only one of which happened.

    Every existing case in the describe above sets `noEmails: false`, which is why
    this went unnoticed: the two conditions were never true together. The
    booking-invoice path already got this right by leaving its policy null once
    something else had withheld.
  */
  it("attributes ONE reason when a copy's organiser also has No emails on", async () => {
    declareEnvironmentRole("non-production");
    mocks.settlementFindUnique
      .mockResolvedValueOnce(settlement(GroupBookingStatus.OPEN))
      .mockResolvedValueOnce({
        groupBooking: {
          status: GroupBookingStatus.OPEN,
          organiserBookingId: "organiser-booking-1",
          organiserBooking: {
            noEmails: false,
            member: { email: "organiser@example.test" },
          },
        },
      })
      .mockResolvedValueOnce({
        groupBooking: {
          status: GroupBookingStatus.OPEN,
          organiserBookingId: "organiser-booking-1",
          organiserBooking: {
            noEmails: true,
            member: { email: "organiser@example.test" },
          },
        },
      });

    await expect(
      createXeroInvoiceForGroupSettlement("settle-1", {
        syncOperationId: "op-1",
      })
    ).resolves.toBe("inv-1");

    expect(mocks.accountingApi.emailInvoice).not.toHaveBeenCalled();
    const completion = mocks.completeSync.mock.calls.at(-1)?.[1];
    // The club's own decision is what happened, and it is the only thing claimed.
    expect(completion.responsePayload.invoiceEmailWithheldByNoEmails).toBe(true);
    expect(
      completion.responsePayload.invoiceEmailWithheldForEnvironment
    ).toBe(false);
    // And the withheld-email audit row still attributes it to the organiser's
    // booking, because an administrator really did set that switch.
    expect(vi.mocked(prisma.emailLog.create)).toHaveBeenCalledWith({
      data: expect.objectContaining({
        bookingId: "organiser-booking-1",
        status: "SKIPPED_NO_EMAILS",
      }),
      select: { id: true },
    });
  });

  it("resolves each child's item-code season from that child's own lodge", async () => {
    // Lodges may run different season windows, so an unscoped season read can
    // match another lodge's row — and Season.type picks the hut-fee item code,
    // and therefore the GL account.
    mocks.settlementFindUnique
      .mockResolvedValueOnce(settlement(GroupBookingStatus.OPEN))
      .mockResolvedValueOnce({
        groupBooking: {
          status: GroupBookingStatus.OPEN,
          organiserBookingId: "organiser-booking-1",
          organiserBooking: {
            noEmails: false,
            member: { email: "organiser@example.test" },
          },
        },
      })
      .mockResolvedValueOnce({
        groupBooking: {
          status: GroupBookingStatus.OPEN,
          organiserBookingId: "organiser-booking-1",
          organiserBooking: {
            noEmails: false,
            member: { email: "organiser@example.test" },
          },
        },
      });

    await expect(
      createXeroInvoiceForGroupSettlement("settle-1", {
        syncOperationId: "op-1",
      })
    ).resolves.toBe("inv-1");

    expect(prisma.season.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ lodgeId: "lodge-1" }),
      }),
    );
  });

  // #2258 semantics: the settlement invoice is ONE combined bill addressed to
  // and paid by the ORGANISER, so it is gated on the organiser's own booking and
  // on nothing else. A joiner's switch does not suppress it.
  it("does not let Xero email the settlement invoice when the ORGANISER'S booking has No emails on", async () => {
    mocks.settlementFindUnique
      .mockResolvedValueOnce(settlement(GroupBookingStatus.OPEN))
      .mockResolvedValueOnce({
        groupBooking: {
          status: GroupBookingStatus.OPEN,
          organiserBookingId: "organiser-booking-1",
          organiserBooking: {
            noEmails: false,
            member: { email: "organiser@example.test" },
          },
        },
      })
      .mockResolvedValueOnce({
        groupBooking: {
          status: GroupBookingStatus.OPEN,
          organiserBookingId: "organiser-booking-1",
          organiserBooking: {
            noEmails: true,
            member: { email: "organiser@example.test" },
          },
        },
      });

    await expect(
      createXeroInvoiceForGroupSettlement("settle-1", {
        syncOperationId: "op-1",
      })
    ).resolves.toBe("inv-1");

    expect(mocks.accountingApi.emailInvoice).not.toHaveBeenCalled();
    // The invoice itself is still raised and never voided — only the email is
    // withheld, and the withhold is attributed to the organiser's booking.
    expect(mocks.accountingApi.createInvoices).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueVoid).not.toHaveBeenCalled();
    expect(vi.mocked(prisma.emailLog.create)).toHaveBeenCalledWith({
      data: expect.objectContaining({
        bookingId: "organiser-booking-1",
        templateName: "xero-group-settlement-invoice-email",
        status: "SKIPPED_NO_EMAILS",
        to: "organiser@example.test",
      }),
      select: { id: true },
    });
  });

  it("voids durably and suppresses email when cancellation commits after the post-create check", async () => {
    mocks.settlementFindUnique
      .mockResolvedValueOnce(settlement(GroupBookingStatus.OPEN))
      .mockResolvedValueOnce({
        groupBooking: {
          status: GroupBookingStatus.OPEN,
          organiserBookingId: "organiser-booking-1",
          organiserBooking: {
            noEmails: false,
            member: { email: "organiser@example.test" },
          },
        },
      })
      .mockResolvedValueOnce({
        groupBooking: {
          status: GroupBookingStatus.CANCELLED,
          organiserBookingId: "organiser-booking-1",
          organiserBooking: {
            noEmails: false,
            member: { email: "organiser@example.test" },
          },
        },
      });

    await expect(
      createXeroInvoiceForGroupSettlement("settle-1", {
        syncOperationId: "op-1",
      })
    ).resolves.toBeNull();

    expect(mocks.settlementUpdate).toHaveBeenCalledWith({
      where: { id: "settle-1" },
      data: { xeroInvoiceId: "inv-1", xeroInvoiceNumber: "INV-1" },
    });
    expect(mocks.accountingApi.updateInvoice).toHaveBeenCalledWith(
      "tenant-1",
      "inv-1",
      { invoices: [{ invoiceID: "inv-1", status: "VOIDED" }] },
      undefined,
      "group-settlement:settle-1:invoice-void-after-cancel:inv-1:v1"
    );
    expect(mocks.accountingApi.emailInvoice).not.toHaveBeenCalled();
    expect(mocks.enqueueVoid).toHaveBeenCalledWith("settle-1", {
      store: mocks.tx,
    });
    expect(mocks.completeSync).toHaveBeenCalledWith(
      "op-1",
      expect.objectContaining({
        status: "SUCCEEDED",
        responsePayload: expect.objectContaining({
          cancelledAfterInvoiceCreation: true,
          invoiceEmailSuppressed: true,
        }),
      })
    );
  });
});

// #3642 (INV-PAY-105): only a settlement still BOUND to an Internet Banking
// invoice gets one, a released settlement never points at (or emails) an
// invoice that arrives after the release, and a replacement invoice is never
// answered with Xero's replay of the one it replaces.
describe("the bound-invoice rule in the create worker (#3642)", () => {
  function organiserFenceRead(overrides: Record<string, unknown> = {}) {
    return {
      groupBooking: {
        status: GroupBookingStatus.OPEN,
        organiserBookingId: "organiser-booking-1",
        organiserBooking: {
          noEmails: false,
          member: { email: "organiser@example.test" },
        },
      },
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tx.$executeRaw.mockResolvedValue(undefined);
    mocks.transaction.mockImplementation(async (callback) => callback(mocks.tx));
    mocks.settlementUpdate.mockResolvedValue({});
    mocks.persisted.current = {};
    mocks.opCorrelationKey.current = null;
    mocks.createRowKeys.current = [];
    mocks.accountingApi.getInvoice.mockResolvedValue({
      body: { invoices: [{ invoiceID: "inv-old", status: "AUTHORISED", amountPaid: 0 }] },
    });
    mocks.enqueueAbandonVoid.mockResolvedValue({ queueOperationId: "void-op-9" });
    vi.mocked(prisma.booking.findMany).mockResolvedValue([
      {
        id: "child-1",
        status: BookingStatus.CONFIRMED,
        lodgeId: "lodge-1",
        checkIn: new Date("2026-07-01"),
        checkOut: new Date("2026-07-02"),
        finalPriceCents: 4500,
        promoAdjustmentCents: 0,
        promoRedemption: null,
        guests: [],
      } as never,
    ]);
    mocks.accountingApi.createInvoices.mockResolvedValue({
      body: { invoices: [{ invoiceID: "inv-1", invoiceNumber: "INV-1", total: 45 }] },
    });
    mocks.accountingApi.emailInvoice.mockResolvedValue({ body: { sent: true } });
    mocks.accountingApi.updateInvoice.mockResolvedValue({
      body: { invoices: [{ invoiceID: "inv-old", status: "VOIDED" }] },
    });
  });

  it("raises nothing for a settlement the reaper released before the CREATE ran", async () => {
    mocks.settlementFindUnique.mockResolvedValue({
      ...settlement(GroupBookingStatus.OPEN),
      status: "FAILED",
    });

    await expect(
      createXeroInvoiceForGroupSettlement("settle-1", { syncOperationId: "op-1" })
    ).resolves.toBeNull();

    expect(mocks.accountingApi.createInvoices).not.toHaveBeenCalled();
    expect(mocks.completeSync).toHaveBeenCalledWith("op-1", {
      status: "SUCCEEDED",
      responsePayload: { settlementNoLongerAwaitingInvoice: true },
    });
  });

  it("abandons an invoice that arrives after the settlement was released: VOID queued, link inactive, never pointed at or emailed", async () => {
    mocks.settlementFindUnique
      .mockResolvedValueOnce(settlement(GroupBookingStatus.OPEN))
      .mockResolvedValueOnce({ status: "FAILED", groupBooking: { status: GroupBookingStatus.OPEN } });

    await expect(
      createXeroInvoiceForGroupSettlement("settle-1", { syncOperationId: "op-1" })
    ).resolves.toBeNull();

    expect(mocks.enqueueAbandonVoid).toHaveBeenCalledWith("settle-1", "inv-1", { store: mocks.tx });
    expect(mocks.upsertLink).toHaveBeenCalledWith(
      expect.objectContaining({ xeroObjectId: "inv-1", role: "GROUP_SETTLEMENT_INVOICE", active: false }),
      { store: mocks.tx }
    );
    expect(mocks.settlementUpdate).not.toHaveBeenCalled();
    expect(mocks.accountingApi.emailInvoice).not.toHaveBeenCalled();
    expect(mocks.completeSync).toHaveBeenCalledWith(
      "op-1",
      expect.objectContaining({
        responsePayload: expect.objectContaining({ abandonedAfterInvoiceCreation: true }),
      })
    );
  });

  it("does not email an invoice the settlement stopped pointing at before the email gate", async () => {
    mocks.settlementFindUnique
      .mockResolvedValueOnce(settlement(GroupBookingStatus.OPEN))
      .mockResolvedValueOnce(organiserFenceRead())
      // The reaper released the settlement between the two fences.
      .mockResolvedValueOnce(organiserFenceRead({ status: "FAILED" }));

    await expect(
      createXeroInvoiceForGroupSettlement("settle-1", { syncOperationId: "op-1" })
    ).resolves.toBeNull();

    expect(mocks.accountingApi.emailInvoice).not.toHaveBeenCalled();
    const completion = mocks.completeSync.mock.calls.at(-1)?.[1];
    expect(completion.responsePayload).toMatchObject({ abandonedBeforeInvoiceEmail: true });
    // The link was written ACTIVE beside the pointer; whoever retired the
    // invoice deactivated it, so the completion writes none.
    expect(completion.extraLinks).toBeUndefined();
  });

  it("keys a replacement invoice by its attempt, so Xero cannot replay the abandoned one", async () => {
    mocks.opCorrelationKey.current = "group-settlement:settle-1:invoice:attempt-1:v1";
    mocks.createRowKeys.current = [
      "group-settlement:settle-1:invoice:v1",
      "group-settlement:settle-1:invoice:attempt-1:v1",
    ];
    mocks.settlementFindUnique.mockResolvedValue(settlement(GroupBookingStatus.OPEN));

    await createXeroInvoiceForGroupSettlement("settle-1", { syncOperationId: "op-1" });

    expect(mocks.accountingApi.createInvoices).toHaveBeenCalledWith(
      "tenant-1",
      expect.anything(),
      undefined,
      undefined,
      "group-settlement:settle-1:invoice:attempt-1:v1"
    );
  });

  it("keeps the original key for a settlement's first invoice", async () => {
    mocks.settlementFindUnique.mockResolvedValue(settlement(GroupBookingStatus.OPEN));

    await createXeroInvoiceForGroupSettlement("settle-1", { syncOperationId: "op-1" });

    expect(mocks.accountingApi.createInvoices).toHaveBeenCalledWith(
      "tenant-1",
      expect.anything(),
      undefined,
      undefined,
      "group-settlement:settle-1:invoice:v1"
    );
  });

  it("voids an abandoned invoice under its own invoice-specific key", async () => {
    mocks.settlementFindUnique.mockResolvedValue({ id: "settle-1", xeroInvoiceId: null });

    await voidXeroInvoiceForAbandonedGroupSettlement("settle-1", "inv-old", {
      syncOperationId: "void-op-9",
    });

    expect(mocks.accountingApi.updateInvoice).toHaveBeenCalledWith(
      "tenant-1",
      "inv-old",
      { invoices: [{ invoiceID: "inv-old", status: "VOIDED" }] },
      undefined,
      "group-settlement:settle-1:invoice-void-after-abandon:inv-old:v1"
    );
    expect(mocks.completeSync).toHaveBeenCalledWith(
      "void-op-9",
      expect.objectContaining({
        status: "SUCCEEDED",
        responsePayload: expect.objectContaining({ abandonedBySettlement: true }),
      })
    );
  });

  it("raises nothing when a later attempt has superseded this row", async () => {
    mocks.opCorrelationKey.current = "group-settlement:settle-1:invoice:v1";
    mocks.createRowKeys.current = [
      "group-settlement:settle-1:invoice:v1",
      "group-settlement:settle-1:invoice:attempt-1:v1",
    ];
    mocks.settlementFindUnique.mockResolvedValue(settlement(GroupBookingStatus.OPEN));

    await expect(
      createXeroInvoiceForGroupSettlement("settle-1", { syncOperationId: "op-1" })
    ).resolves.toBeNull();

    expect(mocks.accountingApi.createInvoices).not.toHaveBeenCalled();
    expect(mocks.completeSync).toHaveBeenCalledWith("op-1", {
      status: "SUCCEEDED",
      responsePayload: { supersededByLaterAttempt: true },
    });
  });

  it("refuses to raise an invoice whose committed children no longer total the settlement", async () => {
    // A joiner edited their booking after the settle: $50 now, not $45.
    vi.mocked(prisma.booking.findMany).mockResolvedValue([
      {
        id: "child-1",
        status: BookingStatus.CONFIRMED,
        lodgeId: "lodge-1",
        checkIn: new Date("2026-07-01"),
        checkOut: new Date("2026-07-02"),
        finalPriceCents: 5000,
        promoAdjustmentCents: 0,
        promoRedemption: null,
        guests: [],
      } as never,
    ]);
    mocks.settlementFindUnique.mockResolvedValue(settlement(GroupBookingStatus.OPEN));

    await expect(
      createXeroInvoiceForGroupSettlement("settle-1", { syncOperationId: "op-1" })
    ).rejects.toThrow(/no invoice was raised/);
    expect(mocks.accountingApi.createInvoices).not.toHaveBeenCalled();
  });

  it("builds the invoice from CONFIRMED children only, never ones already PAID", async () => {
    mocks.settlementFindUnique.mockResolvedValue(settlement(GroupBookingStatus.OPEN));

    await createXeroInvoiceForGroupSettlement("settle-1", { syncOperationId: "op-1" });

    expect(vi.mocked(prisma.booking.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: BookingStatus.CONFIRMED }),
      })
    );
  });

  it("binds the invoice with its ACTIVE link written beside the pointer, under the lock", async () => {
    mocks.settlementFindUnique
      .mockResolvedValueOnce(settlement(GroupBookingStatus.OPEN))
      .mockResolvedValueOnce(organiserFenceRead())
      .mockResolvedValueOnce(organiserFenceRead());

    await expect(
      createXeroInvoiceForGroupSettlement("settle-1", { syncOperationId: "op-1" })
    ).resolves.toBe("inv-1");

    expect(mocks.settlementUpdate).toHaveBeenCalledWith({
      where: { id: "settle-1" },
      data: { xeroInvoiceId: "inv-1", xeroInvoiceNumber: "INV-1" },
    });
    expect(mocks.upsertLink).toHaveBeenCalledWith(
      expect.objectContaining({ xeroObjectId: "inv-1", role: "GROUP_SETTLEMENT_INVOICE" }),
      { store: mocks.tx }
    );
    const link = mocks.upsertLink.mock.calls.find(([l]) => l.xeroObjectId === "inv-1")![0];
    expect(link.active).not.toBe(false);
    expect(mocks.completeSync.mock.calls.at(-1)?.[1].extraLinks).toBeUndefined();
  });

  it("abandons an invoice that arrives after the settlement already points at another one", async () => {
    mocks.settlementFindUnique
      .mockResolvedValueOnce(settlement(GroupBookingStatus.OPEN))
      .mockResolvedValueOnce(organiserFenceRead({ xeroInvoiceId: "inv-other" }));

    await expect(
      createXeroInvoiceForGroupSettlement("settle-1", { syncOperationId: "op-1" })
    ).resolves.toBeNull();

    expect(mocks.enqueueAbandonVoid).toHaveBeenCalledWith("settle-1", "inv-1", { store: mocks.tx });
    expect(mocks.settlementUpdate).not.toHaveBeenCalled();
    expect(mocks.accountingApi.emailInvoice).not.toHaveBeenCalled();
  });

  it("abandons an invoice whose attempt was superseded while Xero was raising it", async () => {
    mocks.opCorrelationKey.current = "group-settlement:settle-1:invoice:v1";
    mocks.createRowKeys.current = ["group-settlement:settle-1:invoice:v1"];
    mocks.settlementFindUnique
      .mockResolvedValueOnce(settlement(GroupBookingStatus.OPEN))
      .mockImplementationOnce(async () => {
        // The organiser's group changed meanwhile: attempt 1 was queued.
        mocks.createRowKeys.current = [
          "group-settlement:settle-1:invoice:v1",
          "group-settlement:settle-1:invoice:attempt-1:v1",
        ];
        return organiserFenceRead();
      });

    await expect(
      createXeroInvoiceForGroupSettlement("settle-1", { syncOperationId: "op-1" })
    ).resolves.toBeNull();

    expect(mocks.enqueueAbandonVoid).toHaveBeenCalledWith("settle-1", "inv-1", { store: mocks.tx });
    expect(mocks.settlementUpdate).not.toHaveBeenCalled();
  });

  it("abandons, alerts and fails an invoice Xero raised at a total different from the settlement's", async () => {
    mocks.accountingApi.createInvoices.mockResolvedValue({
      body: { invoices: [{ invoiceID: "inv-1", invoiceNumber: "INV-1", total: 45.01 }] },
    });
    mocks.settlementFindUnique
      .mockResolvedValueOnce(settlement(GroupBookingStatus.OPEN))
      .mockResolvedValueOnce(organiserFenceRead());

    await expect(
      createXeroInvoiceForGroupSettlement("settle-1", { syncOperationId: "op-1" })
    ).resolves.toBeNull();

    expect(mocks.enqueueAbandonVoid).toHaveBeenCalledWith("settle-1", "inv-1", { store: mocks.tx });
    expect(mocks.settlementUpdate).not.toHaveBeenCalled();
    expect(mocks.alert).toHaveBeenCalledWith(
      expect.objectContaining({ settlementId: "settle-1", invoiceId: "inv-1" }),
      expect.anything()
    );
    expect(mocks.completeSync).toHaveBeenCalledWith(
      "op-1",
      expect.objectContaining({
        status: "FAILED",
        responsePayload: expect.objectContaining({ invoiceTotalDiffersFromSettlement: true }),
      })
    );
  });

  it("completes quietly when the abandoned invoice is already void in Xero", async () => {
    mocks.settlementFindUnique.mockResolvedValue({ id: "settle-1", xeroInvoiceId: null });
    mocks.accountingApi.getInvoice.mockResolvedValue({
      body: { invoices: [{ invoiceID: "inv-old", status: "VOIDED" }] },
    });

    await voidXeroInvoiceForAbandonedGroupSettlement("settle-1", "inv-old", {
      syncOperationId: "void-op-9",
    });

    expect(mocks.accountingApi.updateInvoice).not.toHaveBeenCalled();
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(mocks.completeSync).toHaveBeenCalledWith(
      "void-op-9",
      expect.objectContaining({
        status: "SUCCEEDED",
        responsePayload: expect.objectContaining({ invoiceAlreadyVoid: true }),
      })
    );
  });

  it("alerts once instead of voiding an abandoned invoice that has been part-paid", async () => {
    mocks.settlementFindUnique.mockResolvedValue({ id: "settle-1", xeroInvoiceId: null });
    mocks.accountingApi.getInvoice.mockResolvedValue({
      body: { invoices: [{ invoiceID: "inv-old", status: "AUTHORISED", amountPaid: 500 }] },
    });

    await voidXeroInvoiceForAbandonedGroupSettlement("settle-1", "inv-old", {
      syncOperationId: "void-op-9",
    });

    expect(mocks.accountingApi.updateInvoice).not.toHaveBeenCalled();
    expect(mocks.alert).toHaveBeenCalledTimes(1);
    expect(mocks.alert.mock.calls[0][0]).toMatchObject({
      settlementId: "settle-1",
      invoiceId: "inv-old",
      errorMessage: expect.stringMatching(/\$500\.00 paid/),
    });
    expect(mocks.completeSync).toHaveBeenCalledWith(
      "void-op-9",
      expect.objectContaining({
        status: "SUCCEEDED",
        responsePayload: expect.objectContaining({ invoiceNotVoidedCarriesMoney: true }),
      })
    );
  });

  it("alerts instead of voiding a cancelled group's invoice that carries a credit", async () => {
    mocks.settlementFindUnique.mockResolvedValue({
      id: "settle-1",
      xeroInvoiceId: "inv-old",
      xeroInvoiceNumber: "INV-OLD",
      groupBooking: { status: GroupBookingStatus.CANCELLED },
    });
    mocks.accountingApi.getInvoice.mockResolvedValue({
      body: { invoices: [{ invoiceID: "inv-old", status: "AUTHORISED", amountCredited: 20 }] },
    });

    await voidXeroInvoiceForCancelledGroupSettlement("settle-1", {
      syncOperationId: "void-op-1",
    });

    expect(mocks.accountingApi.updateInvoice).not.toHaveBeenCalled();
    expect(mocks.alert.mock.calls[0][0].errorMessage).toMatch(/cancelled/);
  });


  it("releases the binding, alerts once and says so when a joiner's stored prices cannot make the invoice (#3642 D2)", async () => {
    const { buildInvoiceLineItems } = await import("@/lib/xero-booking-invoices");
    // The child's final price is $45, but its night prices add up to $40.
    vi.mocked(buildInvoiceLineItems).mockReturnValueOnce([
      { description: "One lodge stay", unitAmount: 40, quantity: 1 },
    ]);
    mocks.settlementFindUnique.mockResolvedValue(settlement(GroupBookingStatus.OPEN));

    await expect(
      createXeroInvoiceForGroupSettlement("settle-1", { syncOperationId: "op-1" })
    ).resolves.toBeNull();

    expect(mocks.accountingApi.createInvoices).not.toHaveBeenCalled();
    expect(mocks.tx.groupBookingSettlement.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "settle-1",
        status: "PENDING",
        xeroInvoiceId: null,
        amountCents: 4500,
      }),
      data: { status: "FAILED" },
    });
    expect(mocks.alert).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "lines_disagree_with_prices",
        settlementId: "settle-1",
        invoiceId: null,
      }),
      expect.anything()
    );
    expect(mocks.completeSync).toHaveBeenCalledWith(
      "op-1",
      expect.objectContaining({
        status: "FAILED",
        responsePayload: expect.objectContaining({ invoiceLinesDisagreeWithPrices: true }),
      })
    );
  });

  it("returns an invoice already raised without re-writing its link outside the lock (#3642 D7)", async () => {
    mocks.settlementFindUnique.mockResolvedValue({
      ...settlement(GroupBookingStatus.OPEN),
      xeroInvoiceId: "inv-raised",
      xeroInvoiceNumber: "INV-RAISED",
    });

    await expect(
      createXeroInvoiceForGroupSettlement("settle-1", { syncOperationId: "op-1" })
    ).resolves.toBe("inv-raised");

    expect(mocks.upsertLink).not.toHaveBeenCalled();
    expect(mocks.accountingApi.createInvoices).not.toHaveBeenCalled();
  });

  it("never voids, and alerts, an abandoned invoice the connected Xero organisation does not have (#3642 D3)", async () => {
    mocks.settlementFindUnique.mockResolvedValue({ id: "settle-1", xeroInvoiceId: null });
    mocks.accountingApi.getInvoice.mockRejectedValue(
      Object.assign(new Error("Not Found"), { response: { statusCode: 404 } })
    );

    await voidXeroInvoiceForAbandonedGroupSettlement("settle-1", "inv-old", {
      syncOperationId: "void-op-9",
    });

    expect(mocks.accountingApi.updateInvoice).not.toHaveBeenCalled();
    expect(mocks.alert).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "invoice_not_found", invoiceId: "inv-old" }),
      expect.anything()
    );
    expect(mocks.completeSync).toHaveBeenCalledWith(
      "void-op-9",
      expect.objectContaining({
        status: "SUCCEEDED",
        responsePayload: { invoiceNotFoundInXero: true },
      })
    );
  });

  it("leaves a transient Xero failure to the retry machinery rather than calling it not found", async () => {
    mocks.settlementFindUnique.mockResolvedValue({ id: "settle-1", xeroInvoiceId: null });
    mocks.accountingApi.getInvoice.mockRejectedValue(
      Object.assign(new Error("Service Unavailable"), { response: { statusCode: 503 } })
    );

    await expect(
      voidXeroInvoiceForAbandonedGroupSettlement("settle-1", "inv-old", {
        syncOperationId: "void-op-9",
      })
    ).rejects.toThrow("Service Unavailable");
    expect(mocks.alert).not.toHaveBeenCalled();
  });

  it("never voids the invoice a settlement still points at", async () => {
    mocks.settlementFindUnique.mockResolvedValue({ id: "settle-1", xeroInvoiceId: "inv-old" });

    await voidXeroInvoiceForAbandonedGroupSettlement("settle-1", "inv-old", {
      syncOperationId: "void-op-9",
    });

    expect(mocks.accountingApi.updateInvoice).not.toHaveBeenCalled();
    expect(mocks.completeSync).toHaveBeenCalledWith("void-op-9", {
      status: "SUCCEEDED",
      responsePayload: { skippedInvoiceStillLinkedToSettlement: true },
    });
  });
});
