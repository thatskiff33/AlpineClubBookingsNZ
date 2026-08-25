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
  const tx = {
    $executeRaw: vi.fn(),
    environmentSafetySettings: { findUnique: txEnvironmentSafetyFindUnique },
    groupBookingSettlement: {
      findUnique: settlementFindUnique,
      update: settlementUpdate,
    },
  };
  const accountingApi = {
    createInvoices: vi.fn(),
    updateInvoice: vi.fn(),
    emailInvoice: vi.fn(),
  };
  return {
    tx,
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

vi.mock("@/lib/xero-mappings", () => ({
  getResolvedAccountMapping: vi.fn().mockResolvedValue({
    code: "200",
    itemCode: null,
    codeExplicitlyConfigured: true,
  }),
  getHutFeeItemCodeMap: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("@/lib/xero-booking-invoices", () => ({
  buildInvoiceLineItems: vi.fn(() => [{ description: "One lodge stay" }]),
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
vi.mock("@/lib/xero-group-settlement-void-outbox", () => ({
  enqueueXeroGroupSettlementInvoiceVoidOperation: mocks.enqueueVoid,
}));

import { prisma } from "@/lib/prisma";
import { declareEnvironmentRole } from "@/lib/__tests__/helpers/environment-role";
import {
  createXeroInvoiceForGroupSettlement,
  voidXeroInvoiceForCancelledGroupSettlement,
} from "@/lib/xero-group-settlement-invoices";

function settlement(status: GroupBookingStatus) {
  return {
    id: "settle-1",
    createdAt: new Date("2026-06-01"),
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
        guests: [],
      } as never,
    ]);
    mocks.accountingApi.createInvoices.mockResolvedValue({
      body: { invoices: [{ invoiceID: "inv-1", invoiceNumber: "INV-1" }] },
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
