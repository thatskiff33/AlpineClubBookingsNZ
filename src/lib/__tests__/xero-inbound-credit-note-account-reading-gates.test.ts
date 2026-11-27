/**
 * #4347 (`INV-ADDPAY-041`): the inbound reconcile acts on an account-credit
 * note's reading only while the note's account-credit row, as stored after the
 * reconcile's own link write, still takes it (`accountCreditNoteReadingIsCurrent`).
 * A reading that row refused - a stored void, or a newer stored snapshot -
 * neither stamps the member's cancellation credit nor mirrors the note's spend
 * outside the app, and its allocations reach the member's ledger only through a
 * repair that re-checks under the member's credit lock (pinned in
 * `xero-credit-note-repairs.test.ts` and, against PostgreSQL, in
 * `xero-account-credit-note-stale-live-status.realdb.test.ts`).
 *
 * The judgement module is real; every other collaborator of the reconcile is
 * stubbed, so this pins only where the gate sits.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const NOTE = "cn_4347";
const EARLY = "2026-06-30T11:00:00.000Z";
const LATE = "2026-06-30T12:00:00.000Z";

const mocks = vi.hoisted(() => ({
  linkFindMany: vi.fn(),
  paymentFindMany: vi.fn(),
  paymentUpdate: vi.fn(),
  upsertXeroObjectLink: vi.fn(),
  stamp: vi.fn(),
  held: vi.fn(),
  raisedFor: vi.fn(),
  mirror: vi.fn(),
  mirrorEvidence: vi.fn(),
  allocationRepair: vi.fn(),
  recount: vi.fn(),
  getCreditNote: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroObjectLink: { findMany: mocks.linkFindMany },
    payment: { findMany: mocks.paymentFindMany, update: mocks.paymentUpdate },
  },
}));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/xero-api-client", () => ({
  getAuthenticatedXeroClient: async () => ({ xero: { accountingApi: { getCreditNote: mocks.getCreditNote } }, tenantId: "tenant" }),
  callXeroApi: (call: () => unknown) => call(),
}));
vi.mock("@/lib/xero-sync", () => ({ upsertXeroObjectLink: mocks.upsertXeroObjectLink }));
vi.mock("@/lib/xero-credit-note-mirror", () => ({ creditNoteMirrorEvidenceFrom: mocks.mirrorEvidence, mirrorCreditNoteOutsideSpend: mocks.mirror }));
vi.mock("@/lib/xero-credit-note-spend-evidence", () => ({ creditNoteSpendEvidenceMetadata: async () => ({}), withCreditNoteSpendEvidence: (link: unknown) => link }));
vi.mock("@/lib/xero-account-credit-note-stamp", () => ({ accountCreditNoteHeld: mocks.held, accountCreditNoteRaisedFor: mocks.raisedFor, stampCancellationCreditXeroNote: mocks.stamp }));
vi.mock("@/lib/xero-inbound/object-links", () => ({
  dedupeResolvedXeroObjectLinks: (links: unknown[]) => links,
  dedupeXeroObjectLinks: (links: unknown[]) => links,
  // The payment's account-credit link the earlier reading wrote.
  findActiveXeroObjectLinks: async () => [{ localModel: "Payment", localId: "pay_1", xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE, role: "ACCOUNT_CREDIT_NOTE" }],
  findPaymentIdsWithCancelledRefundNoteMirror: async () => [],
  getDerivedInboundAllocationRole: () => "CREDIT_NOTE_ALLOCATION",
  isDeletedXeroPaymentStatus: () => false,
  recoverBookingScopedLinksFromOutboundOperations: async () => [],
}));
vi.mock("@/lib/xero-inbound/deleted-payment-links", () => ({ creditNotePaymentsForAbsence: () => [], retireDeletedPaymentLinksAbsentFromPayload: async () => 0 }));
vi.mock("@/lib/xero-inbound/audit", () => ({ writeXeroInboundAuditLogs: async () => undefined }));
vi.mock("@/lib/xero-inbound/modification-note-refunds", () => ({ resolveModificationRefundAmountsByPaymentId: async () => new Map() }));
vi.mock("@/lib/xero-inbound/retire-unlisted-credit-note-allocations", () => ({
  creditNoteAllocationSnapshotStamp: () => ({}),
  readStoredCreditNoteSnapshots: async () => [],
  retireUnlistedCreditNoteAllocations: async () => undefined,
  withHeldFloorAlerts: async (run: (held: { alerts: unknown[] }) => unknown) => run({ alerts: [] }),
  writeCurrentCreditNoteAllocations: async () => undefined,
}));
vi.mock("@/lib/xero-inbound/credit-note-repairs", () => ({
  repairAccountCreditAllocationBusinessState: mocks.allocationRepair,
  repairRefundedPaymentBusinessState: mocks.recount,
  resolveAccountCreditPaymentsFromMemberCredits: async () => [],
  resolveAppliedCreditPaymentsFromLocalProvenance: async () => [],
}));

import { reconcileXeroCreditNote } from "@/lib/xero-inbound/credit-note";

/** An older AUTHORISED reading of the $100 account-credit note. */
const OLDER_AUTHORISED = { creditNoteID: NOTE, creditNoteNumber: "CN-4347", status: "AUTHORISED", total: 100, appliedAmount: 0, remainingCredit: 100, updatedDateUTC: new Date(EARLY), allocations: [], payments: [] };

describe("the inbound reconcile's credit stamp and outside-spend mirror act only on a current account-credit reading (#4347)", () => {
  let storedAccountRow: Record<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCreditNote.mockResolvedValue({ body: { creditNotes: [OLDER_AUTHORISED] } });
    // The note's account-credit rows as stored now; every other link read finds none.
    mocks.linkFindMany.mockImplementation(async ({ where }: { where: { role?: unknown } }) => (where.role === "ACCOUNT_CREDIT_NOTE" ? [{ metadata: storedAccountRow }] : []));
    mocks.paymentFindMany.mockImplementation(async ({ where }: { where: { id?: { in: string[] } } }) =>
      where.id?.in?.includes("pay_1") ? [{ id: "pay_1", bookingId: "booking_1", booking: { memberId: "member_1" } }] : [],
    );
    mocks.held.mockResolvedValue(false);
    mocks.raisedFor.mockResolvedValue({ paymentIds: ["pay_1"], memberCreditId: "credit_1" });
    mocks.stamp.mockResolvedValue("credit_1");
    mocks.mirrorEvidence.mockReturnValue({ creditNoteId: NOTE });
    mocks.mirror.mockResolvedValue(undefined);
    mocks.recount.mockResolvedValue({ matchedPayments: 1, updatedPayments: 0 });
    mocks.allocationRepair.mockResolvedValue({ matchedPayments: 0, createdAppliedCredits: 0, updatedAppliedCredits: 0, updatedAppliedPayments: 0, skippedAllocations: 0 });
  });

  it.each([
    ["a stored void", { status: "VOIDED", total: 100, providerUpdatedAt: LATE }],
    ["a newer stored live snapshot", { status: "PAID", total: 100, providerUpdatedAt: LATE }],
  ])("MUTATION: an older reading the row refused (%s) reaches neither the credit stamp nor the mirror", async (_label, stored) => {
    storedAccountRow = stored;
    await reconcileXeroCreditNote(NOTE);
    expect(mocks.stamp).not.toHaveBeenCalled();
    expect(mocks.mirror).not.toHaveBeenCalled();
    // The allocation repair is handed the reading, to re-judge under the member's credit lock.
    expect(mocks.allocationRepair).toHaveBeenCalledWith(NOTE, [], expect.objectContaining({ status: "AUTHORISED", providerUpdatedAt: EARLY }));
  });

  it("a current reading stamps the credit and mirrors the note, as before #4347", async () => {
    storedAccountRow = { status: "AUTHORISED", total: 100, providerUpdatedAt: EARLY };
    await reconcileXeroCreditNote(NOTE);
    expect(mocks.stamp).toHaveBeenCalledTimes(1);
    expect(mocks.mirror).toHaveBeenCalledTimes(1);
  });
});
