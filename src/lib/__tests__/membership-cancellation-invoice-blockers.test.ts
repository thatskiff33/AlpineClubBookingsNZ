import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  memberFindMany: vi.fn(),
  memberSubscriptionFindMany: vi.fn(),
  // #2400: the OTHER record of who a shared invoice covers. The real
  // subscription-credit module runs in these tests rather than being stubbed —
  // the point of the coupling is that the exclusion below and the credit note
  // agree, and a stub would let them drift.
  chargeCoverageFindMany: vi.fn(),
  // #2400 (review F3): the credit note's RECORDED outcome. An invoice whose
  // credit note already ran and skipped is never excused again.
  xeroSyncOperationFindMany: vi.fn(),
  loadMembershipCancellationSettings: vi.fn(),
  getAuthenticatedXeroClient: vi.fn(),
  getInvoices: vi.fn(),
  callXeroApi: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

/** 100 invoices is a full Xero page, so the loader asks for another. */
function fullPage(prefix: string, contactID?: string) {
  return Array.from({ length: 100 }, (_, index) =>
    invoice({ invoiceID: `${prefix}-${index}`, amountDue: 1, contactID }),
  );
}

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findMany: mocks.memberFindMany },
    memberSubscription: { findMany: mocks.memberSubscriptionFindMany },
    membershipSubscriptionChargeCoverage: {
      findMany: mocks.chargeCoverageFindMany,
    },
    xeroSyncOperation: { findMany: mocks.xeroSyncOperationFindMany },
  },
}));

vi.mock("@/lib/membership-cancellation-settings", () => ({
  // The gate reads the STRICT loader: a failed settings read must not read as
  // "archiving is off" (#2392 review, NEW-1).
  loadMembershipCancellationSettingsStrict:
    mocks.loadMembershipCancellationSettings,
}));

vi.mock("@/lib/xero-api-client", () => ({
  getAuthenticatedXeroClient: mocks.getAuthenticatedXeroClient,
  // Pass-through: the metering wrapper itself is not this module's job, but the
  // options handed to it (the fail-fast retry budget) are asserted below.
  callXeroApi: mocks.callXeroApi,
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { buildMembershipCancellationApprovalBlockedMessage } from "@/lib/membership-cancellation-blocker-messages";
import {
  classifyMembershipCancellationInvoiceCheckFailure,
  loadMembershipCancellationInvoiceBlockersByMemberId,
  MEMBERSHIP_CANCELLATION_OPEN_INVOICE_STATUSES,
  membershipCancellationInvoiceCheckCacheSizeForTests,
  resetMembershipCancellationInvoiceBlockerCacheForTests,
} from "@/lib/membership-cancellation-invoice-blockers";

const NOW_MS = Date.UTC(2026, 6, 31, 3, 0, 0);

type InvoiceFixture = {
  invoiceID: string;
  invoiceNumber?: string | null;
  status?: string;
  type?: string;
  amountDue?: number;
  total?: number;
  amountPaid?: number;
  amountCredited?: number;
  currencyCode?: string;
  dueDate?: string | Date | null;
  contactID?: string;
};

function invoice(fixture: InvoiceFixture) {
  return {
    invoiceID: fixture.invoiceID,
    invoiceNumber: fixture.invoiceNumber ?? null,
    status: fixture.status ?? "AUTHORISED",
    type: fixture.type ?? "ACCREC",
    amountDue: fixture.amountDue,
    total: fixture.total,
    amountPaid: fixture.amountPaid,
    amountCredited: fixture.amountCredited,
    currencyCode: fixture.currencyCode ?? "NZD",
    dueDate: fixture.dueDate ?? "2026-06-30",
    contact: { contactID: fixture.contactID ?? "contact-1" },
  };
}

function respondWithInvoices(...pages: unknown[][]) {
  let call = 0;
  mocks.getInvoices.mockImplementation(async () => {
    const body = { invoices: pages[call] ?? [] };
    call += 1;
    return { body };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMembershipCancellationInvoiceBlockerCacheForTests();
  mocks.loadMembershipCancellationSettings.mockResolvedValue({
    warningText: "",
    rejoinProcessText: "",
    xeroArchiveContactsOnCancellation: true,
    xeroContactGroups: [],
  });
  mocks.memberFindMany.mockResolvedValue([
    { id: "member-1", xeroContactId: "contact-1" },
  ]);
  mocks.memberSubscriptionFindMany.mockResolvedValue([]);
  mocks.chargeCoverageFindMany.mockResolvedValue([]);
  // No cancellation credit note has run yet, which is what every approval-time
  // read sees (#2400 review, F3).
  mocks.xeroSyncOperationFindMany.mockResolvedValue([]);
  mocks.getAuthenticatedXeroClient.mockResolvedValue({
    xero: { accountingApi: { getInvoices: mocks.getInvoices } },
    tenantId: "tenant-1",
  });
  respondWithInvoices([]);
});

describe("membership cancellation unpaid-invoice blockers", () => {
  it("blocks on an authorised invoice with an amount still due", async () => {
    respondWithInvoices([
      invoice({
        invoiceID: "inv-1",
        invoiceNumber: "INV-0042",
        amountDue: 120.5,
        dueDate: "2026-06-30",
      }),
    ]);

    const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
      ["member-1"],
      { nowMs: NOW_MS },
    );

    expect(blockers.get("member-1")).toEqual([
      {
        type: "unpaid_invoice",
        invoiceId: "inv-1",
        invoiceNumber: "INV-0042",
        invoiceStatus: "AUTHORISED",
        direction: "receivable",
        amountDueCents: 12050,
        currency: "NZD",
        dueDate: "2026-06-30",
        xeroUrl: expect.stringContaining("inv-1"),
        // The contact link is what makes an unnumbered invoice — and any bill —
        // findable, so it is carried on every row (#2392 review, H1).
        xeroContactUrl: expect.stringContaining("contact-1"),
      },
    ]);
  });

  it("asks Xero only for the open statuses, and fails fast rather than waiting out a rate limit", async () => {
    await loadMembershipCancellationInvoiceBlockersByMemberId(["member-1"], {
      nowMs: NOW_MS,
    });

    const args = mocks.getInvoices.mock.calls[0];
    expect(args[6]).toEqual(["contact-1"]); // contactIDs
    expect(args[7]).toEqual(["AUTHORISED", "SUBMITTED"]); // statuses
    expect(args[9]).toBe(false); // includeArchived
    expect(MEMBERSHIP_CANCELLATION_OPEN_INVOICE_STATUSES).toEqual([
      "AUTHORISED",
      "SUBMITTED",
    ]);

    // An admin is waiting on this call, so it must drop into the "try again"
    // branch quickly rather than sit in the default two-minute rate-limit wait.
    expect(mocks.callXeroApi).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ maxRetries: 1, maxWaitSec: 15 }),
    );
  });

  it("blocks on a SUBMITTED invoice with a balance", async () => {
    respondWithInvoices([
      invoice({
        invoiceID: "inv-2",
        invoiceNumber: "INV-0050",
        status: "SUBMITTED",
        amountDue: 45,
      }),
    ]);

    const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
      ["member-1"],
      { nowMs: NOW_MS },
    );

    expect(blockers.get("member-1")).toHaveLength(1);
    expect(blockers.get("member-1")?.[0]).toMatchObject({
      invoiceStatus: "SUBMITTED",
      amountDueCents: 4500,
    });
  });

  it("does not block on paid, voided, deleted or draft invoices", async () => {
    respondWithInvoices([
      // Fully settled — Xero reports zero due even while the row is returned.
      invoice({ invoiceID: "paid", status: "PAID", amountDue: 0 }),
      invoice({ invoiceID: "voided", status: "VOIDED", amountDue: 99 }),
      invoice({ invoiceID: "deleted", status: "DELETED", amountDue: 99 }),
      invoice({ invoiceID: "draft", status: "DRAFT", amountDue: 99 }),
      // A zero-dollar authorised invoice owes nobody anything.
      invoice({ invoiceID: "zero", status: "AUTHORISED", amountDue: 0 }),
    ]);

    const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
      ["member-1"],
      { nowMs: NOW_MS },
    );

    expect(blockers.get("member-1")).toEqual([]);
  });

  it("blocks on the residual balance when a credit note only partly offsets an invoice", async () => {
    respondWithInvoices([
      invoice({
        invoiceID: "inv-part",
        invoiceNumber: "INV-0060",
        status: "AUTHORISED",
        // Xero omits AmountDue on some payloads; total - paid - credited is the
        // documented fallback, and 100 - 0 - 70 leaves 30 still owing.
        total: 100,
        amountPaid: 0,
        amountCredited: 70,
        amountDue: undefined,
      }),
    ]);

    const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
      ["member-1"],
      { nowMs: NOW_MS },
    );

    expect(blockers.get("member-1")?.[0]).toMatchObject({
      invoiceNumber: "INV-0060",
      amountDueCents: 3000,
    });
  });

  it("blocks on an unpaid bill the club owes the contact", async () => {
    respondWithInvoices([
      invoice({
        invoiceID: "bill-1",
        invoiceNumber: "BILL-9",
        type: "ACCPAY",
        amountDue: 12,
      }),
    ]);

    const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
      ["member-1"],
      { nowMs: NOW_MS },
    );

    expect(blockers.get("member-1")?.[0]).toMatchObject({
      direction: "payable",
      xeroUrl: null,
    });
  });

  it("ignores the subscription invoice this very approval is about to credit", async () => {
    mocks.memberSubscriptionFindMany.mockResolvedValue([
      {
        memberId: "member-1",
        xeroInvoiceId: "sub-invoice",
        member: { xeroContactId: "contact-1" },
      },
    ]);
    respondWithInvoices([
      invoice({ invoiceID: "sub-invoice", invoiceNumber: "SUB-1", amountDue: 90 }),
      invoice({ invoiceID: "inv-other", invoiceNumber: "INV-7", amountDue: 25 }),
    ]);

    const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
      ["member-1"],
      { nowMs: NOW_MS },
    );

    expect(blockers.get("member-1")).toHaveLength(1);
    expect(blockers.get("member-1")?.[0]).toMatchObject({
      invoiceNumber: "INV-7",
    });
    expect(mocks.memberSubscriptionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          // 31 July 2026 in the club's zone is season 2026 on the default 31-March
          // year-end. Written out rather than derived: an expectation computed by
          // the function under test holds for any implementation (#2870).
          seasonYear: 2026,
          status: { in: ["UNPAID", "OVERDUE"] },
        }),
      }),
    );
  });

  it("does not let one member's self-credited invoice excuse another sharing the same contact", async () => {
    mocks.memberFindMany.mockResolvedValue([
      { id: "member-1", xeroContactId: "contact-1" },
      { id: "member-2", xeroContactId: "contact-1" },
    ]);
    mocks.memberSubscriptionFindMany.mockResolvedValue([
      {
        memberId: "member-1",
        xeroInvoiceId: "sub-invoice",
        member: { xeroContactId: "contact-1" },
      },
    ]);
    respondWithInvoices([
      invoice({ invoiceID: "sub-invoice", invoiceNumber: "SUB-1", amountDue: 90 }),
    ]);

    const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
      ["member-1", "member-2"],
      { nowMs: NOW_MS },
    );

    expect(blockers.get("member-1")).toEqual([]);
    expect(blockers.get("member-2")).toHaveLength(1);
  });

  // #2400: the exclusion above excuses an invoice because the approval is about
  // to credit it. Since #2400 the approval credits NOTHING while the invoice
  // still covers members who are staying — so the excuse has to go with it, or
  // the approval archives a Xero contact with a real balance behind it.
  describe("a shared family invoice the approval will not credit", () => {
    /**
     * The module asks two different questions of `memberSubscription`: which
     * season subscription would be credited, and who else that invoice is linked
     * to. The fake answers on the shape of the `where`, as the database would.
     */
    function respondWithSubscriptions(input: {
      season?: Array<Record<string, unknown>>;
      linkedToInvoice?: Array<Record<string, unknown>>;
    }) {
      mocks.memberSubscriptionFindMany.mockImplementation(
        async (args: { where?: Record<string, unknown> }) =>
          args?.where?.seasonYear !== undefined
            ? (input.season ?? []).map((row) => ({
                member: { xeroContactId: "contact-1" },
                ...row,
              }))
            : (input.linkedToInvoice ?? []),
      );
    }

    /** A settled cancellation credit-note operation for one subscription. */
    function creditNoteAlreadyRan(subscriptionId: string) {
      mocks.xeroSyncOperationFindMany.mockResolvedValue([
        { localId: subscriptionId },
      ]);
    }

    beforeEach(() => {
      // The leaver holds the family's Xero contact; the sibling has none of
      // their own, which is the ordinary shape for a child on a family invoice.
      mocks.memberFindMany.mockResolvedValue([
        {
          id: "member-1",
          xeroContactId: "contact-1",
          firstName: "Ada",
          lastName: "Smith",
          cancelledAt: null,
        },
        {
          id: "member-2",
          xeroContactId: null,
          firstName: "Bob",
          lastName: "Smith",
          cancelledAt: null,
        },
      ]);
      respondWithInvoices([
        invoice({
          invoiceID: "sub-invoice",
          invoiceNumber: "SUB-1",
          amountDue: 90,
        }),
      ]);
    });

    it("keeps blocking while another covered member is staying", async () => {
      respondWithSubscriptions({
        season: [
          {
            id: "sub-1",
            memberId: "member-1",
            xeroInvoiceId: "sub-invoice",
            xeroInvoiceNumber: "SUB-1",
          },
        ],
        linkedToInvoice: [
          { memberId: "member-1", xeroInvoiceId: "sub-invoice" },
          { memberId: "member-2", xeroInvoiceId: "sub-invoice" },
        ],
      });

      const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
        ["member-1"],
        { nowMs: NOW_MS },
      );

      expect(blockers.get("member-1")).toHaveLength(1);
      expect(blockers.get("member-1")?.[0]).toMatchObject({
        type: "unpaid_invoice",
        invoiceNumber: "SUB-1",
        amountDueCents: 9000,
      });
    });

    it("excuses it again once the rest of the family has been cancelled", async () => {
      respondWithSubscriptions({
        season: [
          {
            id: "sub-1",
            memberId: "member-1",
            xeroInvoiceId: "sub-invoice",
            xeroInvoiceNumber: "SUB-1",
          },
        ],
        linkedToInvoice: [
          { memberId: "member-1", xeroInvoiceId: "sub-invoice" },
          { memberId: "member-2", xeroInvoiceId: "sub-invoice" },
        ],
      });
      mocks.memberFindMany.mockResolvedValue([
        {
          id: "member-1",
          xeroContactId: "contact-1",
          firstName: "Ada",
          lastName: "Smith",
          cancelledAt: null,
        },
        {
          id: "member-2",
          xeroContactId: null,
          firstName: "Bob",
          lastName: "Smith",
          cancelledAt: new Date(NOW_MS),
        },
      ]);

      const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
        ["member-1"],
        { nowMs: NOW_MS },
      );

      // Last one out: the approval credits the whole balance, so the invoice is
      // excused exactly as it was before #2400.
      expect(blockers.get("member-1")).toEqual([]);
    });

    it("blocks on an active coverage claim even where the subscription link is gone", async () => {
      respondWithSubscriptions({
        season: [
          {
            id: "sub-1",
            memberId: "member-1",
            xeroInvoiceId: "sub-invoice",
            xeroInvoiceNumber: "SUB-1",
          },
        ],
        linkedToInvoice: [
          { memberId: "member-1", xeroInvoiceId: "sub-invoice" },
        ],
      });
      mocks.chargeCoverageFindMany.mockResolvedValue([
        {
          charge: { xeroInvoiceId: "sub-invoice" },
          subscription: { memberId: "member-2" },
        },
      ]);

      const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
        ["member-1"],
        { nowMs: NOW_MS },
      );

      expect(blockers.get("member-1")).toHaveLength(1);
    });

    // #2400 (review F3): the one that used to archive a contact over a live
    // balance. Every covered member has now been cancelled, so "would this
    // credit in full?" answers YES again — but this member's credit note already
    // had its single run, while the siblings were live, and skipped. Nothing is
    // going to credit that invoice, so nothing may excuse it.
    it("does not excuse an invoice whose credit note already ran and skipped", async () => {
      respondWithSubscriptions({
        season: [
          {
            id: "sub-1",
            memberId: "member-1",
            xeroInvoiceId: "sub-invoice",
            xeroInvoiceNumber: "SUB-1",
          },
        ],
        linkedToInvoice: [
          { memberId: "member-1", xeroInvoiceId: "sub-invoice" },
          { memberId: "member-2", xeroInvoiceId: "sub-invoice" },
        ],
      });
      // The whole family is cancelled now, so the live covered set is empty.
      mocks.memberFindMany.mockResolvedValue([
        {
          id: "member-1",
          xeroContactId: "contact-1",
          firstName: "Ada",
          lastName: "Smith",
          cancelledAt: new Date(NOW_MS),
          active: false,
        },
        {
          id: "member-2",
          xeroContactId: null,
          firstName: "Bob",
          lastName: "Smith",
          cancelledAt: new Date(NOW_MS),
          active: false,
        },
      ]);
      creditNoteAlreadyRan("sub-1");

      const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
        ["member-1"],
        { nowMs: NOW_MS, fresh: true },
      );

      expect(blockers.get("member-1")).toHaveLength(1);
      expect(blockers.get("member-1")?.[0]).toMatchObject({
        invoiceNumber: "SUB-1",
      });
    });

    it("is the same answer the archive re-check gets, so the contact is not archived over a live balance", async () => {
      // `syncXeroMembershipCancellationContact` calls this very loader with
      // `fresh: true` immediately before it archives, and defers on any blocker.
      // The credit note having skipped is exactly why this must not come back
      // empty (#2392 review NEW-1, #2400).
      respondWithSubscriptions({
        season: [
          {
            id: "sub-1",
            memberId: "member-1",
            xeroInvoiceId: "sub-invoice",
            xeroInvoiceNumber: "SUB-1",
          },
        ],
        linkedToInvoice: [
          { memberId: "member-1", xeroInvoiceId: "sub-invoice" },
          { memberId: "member-2", xeroInvoiceId: "sub-invoice" },
        ],
      });

      const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
        ["member-1"],
        { nowMs: NOW_MS, fresh: true },
      );

      expect(
        buildMembershipCancellationApprovalBlockedMessage(
          blockers.get("member-1") ?? [],
        ),
      ).toContain("SUB-1");
    });
  });

  it("blocks an organisation contact carrying several booking invoices, oldest due first", async () => {
    mocks.memberFindMany.mockResolvedValue([
      { id: "school-1", xeroContactId: "contact-school" },
    ]);
    respondWithInvoices([
      invoice({
        invoiceID: "inv-b",
        invoiceNumber: "INV-0102",
        amountDue: 400,
        dueDate: "2026-08-31",
        contactID: "contact-school",
      }),
      invoice({
        invoiceID: "inv-a",
        invoiceNumber: "INV-0101",
        amountDue: 250,
        dueDate: "2026-05-31",
        contactID: "contact-school",
      }),
    ]);

    const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
      ["school-1"],
      { nowMs: NOW_MS },
    );

    expect(
      blockers.get("school-1")?.map((blocker) =>
        blocker.type === "unpaid_invoice" ? blocker.invoiceNumber : blocker.type,
      ),
    ).toEqual(["INV-0101", "INV-0102"]);
  });

  // #2392 review (L12): the organisation case was covered at the loader and at
  // the approval guard, but never joined up — nobody asserted what the approver
  // of a school account actually reads when they press Approve.
  it("turns an organisation's Xero invoices into the refusal its approver reads", async () => {
    mocks.memberFindMany.mockResolvedValue([
      { id: "school-1", xeroContactId: "contact-school" },
    ]);
    respondWithInvoices([
      invoice({
        invoiceID: "inv-a",
        invoiceNumber: "INV-0101",
        amountDue: 250,
        dueDate: "2026-05-31",
        contactID: "contact-school",
      }),
      invoice({
        // Xero leaves bills unnumbered routinely; this is the row that used to
        // be unactionable, named only by a GUID nobody can search for.
        invoiceID: "bill-guid-9",
        invoiceNumber: null,
        type: "ACCPAY",
        amountDue: 60,
        dueDate: "2026-06-15",
        contactID: "contact-school",
      }),
    ]);

    const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
      ["school-1"],
      { nowMs: NOW_MS },
    );
    const message = buildMembershipCancellationApprovalBlockedMessage(
      blockers.get("school-1") ?? [],
    );

    expect(message).toContain("INV-0101 (NZD 250.00)");
    expect(message).toContain("(no number, Xero id bill-guid-9) (NZD 60.00)");
    expect(message).toContain(
      "paid, credited with an allocated credit note, or voided in Xero",
    );
    expect(message).toContain("listed beside this participant");
    // The unnumbered bill has no invoice-view URL, so its way into Xero is the
    // contact page — which is exactly why every row carries one.
    expect(
      blockers.get("school-1")?.map((blocker) =>
        blocker.type === "unpaid_invoice" ? blocker.xeroContactUrl : null,
      ),
    ).toEqual([
      expect.stringContaining("contact-school"),
      expect.stringContaining("contact-school"),
    ]);
  });

  it("matches contacts case-insensitively", async () => {
    mocks.memberFindMany.mockResolvedValue([
      { id: "member-1", xeroContactId: "CONTACT-1" },
    ]);
    respondWithInvoices([
      invoice({ invoiceID: "inv-1", invoiceNumber: "INV-1", amountDue: 5, contactID: "contact-1" }),
    ]);

    const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
      ["member-1"],
      { nowMs: NOW_MS },
    );

    expect(blockers.get("member-1")).toHaveLength(1);
  });

  it("pages through Xero until a short page", async () => {
    respondWithInvoices(fullPage("page1"), [
      invoice({ invoiceID: "page2-0", amountDue: 1 }),
    ]);

    const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
      ["member-1"],
      { nowMs: NOW_MS },
    );

    expect(mocks.getInvoices).toHaveBeenCalledTimes(2);
    expect(blockers.get("member-1")).toHaveLength(101);
  });

  // #2392 review (M4/NEW-3): the review queue's page size goes up to 100
  // requests, each with several participants, so an unchunked contactIDs list
  // is a few hundred GUIDs in one query string.
  describe("batching contact ids", () => {
    function membersWithContacts(count: number) {
      return Array.from({ length: count }, (_, index) => ({
        id: `member-${index}`,
        xeroContactId: `contact-${index}`,
      }));
    }

    it("never asks Xero about more than 40 contacts in one call", async () => {
      const members = membersWithContacts(95);
      mocks.memberFindMany.mockResolvedValue(members);

      await loadMembershipCancellationInvoiceBlockersByMemberId(
        members.map((member) => member.id),
        { nowMs: NOW_MS },
      );

      expect(mocks.getInvoices).toHaveBeenCalledTimes(3);
      const batches = mocks.getInvoices.mock.calls.map((call) => call[6]);
      expect(batches.map((batch: string[]) => batch.length)).toEqual([
        40, 40, 15,
      ]);
      // Every contact is asked about exactly once, across the batches.
      expect(new Set(batches.flat()).size).toBe(95);
    });

    it("still answers for every member once the batches are stitched back together", async () => {
      const members = membersWithContacts(45);
      mocks.memberFindMany.mockResolvedValue(members);
      let call = 0;
      mocks.getInvoices.mockImplementation(async () => {
        call += 1;
        return call === 2
          ? {
              body: {
                invoices: [
                  invoice({
                    invoiceID: "inv-late",
                    invoiceNumber: "INV-LATE",
                    amountDue: 5,
                    contactID: "contact-44",
                  }),
                ],
              },
            }
          : { body: { invoices: [] } };
      });

      const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
        members.map((member) => member.id),
        { nowMs: NOW_MS },
      );

      expect(blockers.get("member-44")).toHaveLength(1);
      expect(blockers.get("member-0")).toEqual([]);
    });
  });

  // #2392 review (M5/NEW-2): Xero orders the batch DueDate ASC across every
  // contact in it, so one high-volume contact can eat the whole page budget and
  // leave a different member with an empty bucket. An empty bucket renders as
  // "no blockers" and enables Approve, which is precisely the promise this
  // feature makes — that a reviewer finds out BEFORE they press it.
  describe("when the read is truncated", () => {
    it("reports an unknown answer rather than a clean one", async () => {
      respondWithInvoices(
        fullPage("p1"),
        fullPage("p2"),
        fullPage("p3"),
        fullPage("p4"),
        fullPage("p5"),
        fullPage("p6"),
      );

      const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
        ["member-1"],
        { nowMs: NOW_MS },
      );

      expect(mocks.getInvoices).toHaveBeenCalledTimes(5);
      expect(blockers.get("member-1")).toEqual([
        { type: "invoice_check_unavailable", reason: "too_many_invoices" },
      ]);
    });

    it("never leaves a quiet contact in the same batch looking clear", async () => {
      mocks.memberFindMany.mockResolvedValue([
        { id: "busy-org", xeroContactId: "contact-busy" },
        { id: "quiet-member", xeroContactId: "contact-quiet" },
      ]);
      // Every row belongs to the busy contact; the quiet one's invoices, if it
      // has any, are past the cap and were never seen.
      respondWithInvoices(
        ...Array.from({ length: 6 }, (_, page) =>
          fullPage(`p${page}`, "contact-busy"),
        ),
      );

      const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
        ["busy-org", "quiet-member"],
        { nowMs: NOW_MS },
      );

      expect(blockers.get("quiet-member")).toEqual([
        { type: "invoice_check_unavailable", reason: "too_many_invoices" },
      ]);
    });

    it("does not memoise the truncated answer", async () => {
      respondWithInvoices(
        ...Array.from({ length: 6 }, (_, page) => fullPage(`p${page}`)),
      );
      await loadMembershipCancellationInvoiceBlockersByMemberId(["member-1"], {
        nowMs: NOW_MS,
      });

      respondWithInvoices([]);
      const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
        ["member-1"],
        { nowMs: NOW_MS },
      );

      expect(blockers.get("member-1")).toEqual([]);
    });
  });

  describe("when the check cannot run at all", () => {
    it("makes no Xero call and blocks nothing while contact archiving is off", async () => {
      mocks.loadMembershipCancellationSettings.mockResolvedValue({
        warningText: "",
        rejoinProcessText: "",
        xeroArchiveContactsOnCancellation: false,
        xeroContactGroups: [],
      });

      const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
        ["member-1"],
        { nowMs: NOW_MS },
      );

      expect(blockers.get("member-1")).toEqual([]);
      expect(mocks.getAuthenticatedXeroClient).not.toHaveBeenCalled();
      expect(mocks.memberFindMany).not.toHaveBeenCalled();
    });

    it("makes no Xero call for a member with no linked Xero contact", async () => {
      mocks.memberFindMany.mockResolvedValue([
        { id: "member-1", xeroContactId: null },
      ]);

      const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
        ["member-1"],
        { nowMs: NOW_MS },
      );

      expect(blockers.get("member-1")).toEqual([]);
      expect(mocks.getAuthenticatedXeroClient).not.toHaveBeenCalled();
      // It stops there rather than going on to work out what the cancellation
      // would have credited: with no contact there is nothing to protect.
      expect(mocks.memberSubscriptionFindMany).not.toHaveBeenCalled();
    });

    it("returns an entry for every member asked about", async () => {
      const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
        ["member-1", "member-unknown"],
        { nowMs: NOW_MS },
      );

      expect(blockers.has("member-unknown")).toBe(true);
      expect(blockers.get("member-unknown")).toEqual([]);
    });
  });

  describe("fail-safe: an unknown answer blocks", () => {
    it("blocks with reason 'disconnected' when Xero is not connected", async () => {
      const error = new Error("Xero is not connected.");
      error.name = "XeroReconnectRequiredError";
      mocks.getAuthenticatedXeroClient.mockRejectedValue(error);

      const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
        ["member-1"],
        { nowMs: NOW_MS },
      );

      expect(blockers.get("member-1")).toEqual([
        { type: "invoice_check_unavailable", reason: "disconnected" },
      ]);
    });

    it("blocks with reason 'rate_limited' when the Xero daily limit is in force", async () => {
      const error = new Error("Xero daily API limit reached.");
      error.name = "XeroDailyLimitError";
      mocks.getAuthenticatedXeroClient.mockRejectedValue(error);

      const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
        ["member-1"],
        { nowMs: NOW_MS },
      );

      expect(blockers.get("member-1")).toEqual([
        { type: "invoice_check_unavailable", reason: "rate_limited" },
      ]);
    });

    it("blocks with reason 'unavailable' when Xero cannot be reached", async () => {
      mocks.getInvoices.mockRejectedValue(new Error("socket hang up"));

      const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
        ["member-1"],
        { nowMs: NOW_MS },
      );

      expect(blockers.get("member-1")).toEqual([
        { type: "invoice_check_unavailable", reason: "unavailable" },
      ]);
    });

    it("leaves a member with no Xero contact unblocked even while Xero is down", async () => {
      mocks.memberFindMany.mockResolvedValue([
        { id: "member-1", xeroContactId: "contact-1" },
        { id: "member-2", xeroContactId: null },
      ]);
      mocks.getInvoices.mockRejectedValue(new Error("socket hang up"));

      const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
        ["member-1", "member-2"],
        { nowMs: NOW_MS },
      );

      expect(blockers.get("member-1")).toHaveLength(1);
      expect(blockers.get("member-2")).toEqual([]);
    });

    it("classifies raw Xero HTTP failures", () => {
      expect(
        classifyMembershipCancellationInvoiceCheckFailure({
          response: { statusCode: 401 },
        }),
      ).toBe("disconnected");
      expect(
        classifyMembershipCancellationInvoiceCheckFailure({
          response: { statusCode: 429 },
        }),
      ).toBe("rate_limited");
      expect(
        classifyMembershipCancellationInvoiceCheckFailure({
          response: { statusCode: 503 },
        }),
      ).toBe("unavailable");
    });

    // #2392 review (M3): a stale contact id returns 400 forever. Reporting that
    // as "try again in a few minutes" is a refusal with no route forward.
    it("separates Xero refusing the request from Xero being unreachable", () => {
      expect(
        classifyMembershipCancellationInvoiceCheckFailure({
          response: { statusCode: 400 },
        }),
      ).toBe("invalid_request");
      expect(
        classifyMembershipCancellationInvoiceCheckFailure({
          response: { statusCode: 404 },
        }),
      ).toBe("invalid_request");
    });

    it("blocks with reason 'invalid_request' when Xero rejects the contact id", async () => {
      mocks.getInvoices.mockRejectedValue({ response: { statusCode: 400 } });

      const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
        ["member-1"],
        { nowMs: NOW_MS },
      );

      expect(blockers.get("member-1")).toEqual([
        { type: "invoice_check_unavailable", reason: "invalid_request" },
      ]);
    });

    // #2392 review (NEW-1b): the defaults have archiving OFF, so a settings read
    // that quietly degraded would skip the check on the strength of a database
    // blip — while the archive, an outbox operation drained minutes later, reads
    // the setting again and succeeds.
    it("still runs the check when the archive setting could not be read", async () => {
      mocks.loadMembershipCancellationSettings.mockRejectedValue(
        new Error("database unavailable"),
      );
      respondWithInvoices([
        invoice({ invoiceID: "inv-1", invoiceNumber: "INV-1", amountDue: 40 }),
      ]);

      const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
        ["member-1"],
        { nowMs: NOW_MS },
      );

      expect(mocks.getAuthenticatedXeroClient).toHaveBeenCalled();
      expect(blockers.get("member-1")).toHaveLength(1);
    });

    it("never caches a failure", async () => {
      mocks.getInvoices.mockRejectedValueOnce(new Error("socket hang up"));
      await loadMembershipCancellationInvoiceBlockersByMemberId(["member-1"], {
        nowMs: NOW_MS,
      });

      respondWithInvoices([]);
      const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
        ["member-1"],
        { nowMs: NOW_MS },
      );

      expect(blockers.get("member-1")).toEqual([]);
    });
  });

  describe("the review queue's memo", () => {
    it("reuses a recent answer instead of calling Xero again", async () => {
      respondWithInvoices([invoice({ invoiceID: "inv-1", amountDue: 10 })]);
      await loadMembershipCancellationInvoiceBlockersByMemberId(["member-1"], {
        nowMs: NOW_MS,
      });
      await loadMembershipCancellationInvoiceBlockersByMemberId(["member-1"], {
        nowMs: NOW_MS + 30_000,
      });

      expect(mocks.getInvoices).toHaveBeenCalledTimes(1);
    });

    it("expires after a minute", async () => {
      respondWithInvoices([invoice({ invoiceID: "inv-1", amountDue: 10 })]);
      await loadMembershipCancellationInvoiceBlockersByMemberId(["member-1"], {
        nowMs: NOW_MS,
      });
      respondWithInvoices([invoice({ invoiceID: "inv-1", amountDue: 10 })]);
      await loadMembershipCancellationInvoiceBlockersByMemberId(["member-1"], {
        nowMs: NOW_MS + 61_000,
      });

      expect(mocks.getInvoices).toHaveBeenCalledTimes(2);
    });

    // #2392 review (LOW-6): a process-lifetime Map with one entry per contact
    // ever checked, each holding up to a page of blocker objects.
    it("drops expired entries instead of holding them for the life of the process", async () => {
      mocks.memberFindMany.mockResolvedValue([
        { id: "member-1", xeroContactId: "contact-1" },
      ]);
      respondWithInvoices([invoice({ invoiceID: "inv-1", amountDue: 10 })]);
      await loadMembershipCancellationInvoiceBlockersByMemberId(["member-1"], {
        nowMs: NOW_MS,
      });
      expect(membershipCancellationInvoiceCheckCacheSizeForTests()).toBe(1);

      mocks.memberFindMany.mockResolvedValue([
        { id: "member-2", xeroContactId: "contact-2" },
      ]);
      respondWithInvoices([]);
      await loadMembershipCancellationInvoiceBlockersByMemberId(["member-2"], {
        nowMs: NOW_MS + 600_000,
      });

      // contact-1's entry expired ten minutes ago and is gone, rather than
      // accumulating alongside contact-2's.
      expect(membershipCancellationInvoiceCheckCacheSizeForTests()).toBe(1);
    });

    // #2392 review (residual 3): the TTL sweep alone cannot bound the memo — a
    // busy process checks contacts faster than they expire — so there is a hard
    // ceiling that drops the whole map. Only the expiry half was covered.
    it("drops the whole memo once it passes its size ceiling, expired or not", async () => {
      const manyMembers = Array.from({ length: 501 }, (_, index) => ({
        id: `member-${index}`,
        xeroContactId: `contact-${index}`,
      }));
      mocks.memberFindMany.mockResolvedValue(manyMembers);
      respondWithInvoices([]);
      await loadMembershipCancellationInvoiceBlockersByMemberId(
        manyMembers.map((member) => member.id),
        { nowMs: NOW_MS },
      );
      expect(membershipCancellationInvoiceCheckCacheSizeForTests()).toBe(501);

      // One second later: every one of those entries is still well inside its
      // 60s TTL, so the expiry sweep would keep all 501. The ceiling clears them
      // anyway, leaving only the contact this call fetched.
      mocks.memberFindMany.mockResolvedValue([
        { id: "member-new", xeroContactId: "contact-new" },
      ]);
      respondWithInvoices([]);
      await loadMembershipCancellationInvoiceBlockersByMemberId(["member-new"], {
        nowMs: NOW_MS + 1_000,
      });

      expect(membershipCancellationInvoiceCheckCacheSizeForTests()).toBe(1);

      // And the dropped entries are genuinely gone: an evicted contact is read
      // from Xero again rather than answered from a memo that no longer holds it.
      mocks.getInvoices.mockClear();
      mocks.memberFindMany.mockResolvedValue([
        { id: "member-0", xeroContactId: "contact-0" },
      ]);
      respondWithInvoices([]);
      await loadMembershipCancellationInvoiceBlockersByMemberId(["member-0"], {
        nowMs: NOW_MS + 2_000,
      });

      expect(mocks.getInvoices).toHaveBeenCalledTimes(1);
    });

    it("is bypassed when the caller asks for a fresh answer", async () => {
      respondWithInvoices([invoice({ invoiceID: "inv-1", amountDue: 10 })]);
      await loadMembershipCancellationInvoiceBlockersByMemberId(["member-1"], {
        nowMs: NOW_MS,
      });

      respondWithInvoices([
        invoice({ invoiceID: "inv-2", invoiceNumber: "INV-NEW", amountDue: 10 }),
      ]);
      const blockers = await loadMembershipCancellationInvoiceBlockersByMemberId(
        ["member-1"],
        { nowMs: NOW_MS + 1_000, fresh: true },
      );

      expect(mocks.getInvoices).toHaveBeenCalledTimes(2);
      expect(blockers.get("member-1")?.[0]).toMatchObject({
        invoiceNumber: "INV-NEW",
      });
    });
  });
});
