// F21 (#1886): the entrance-fee invoice worker must never mint a second
// invoice for the same member. The enqueue-time guard only blocks when a link
// ALREADY exists, and its PENDING/RUNNING dedupe is keyed on amount + category,
// so a second enqueue carrying a different amount override (or a reclassified
// category) slips past both. The worker therefore re-checks the durable
// ENTRANCE_FEE_INVOICE link and, failing that, adopts a prior mint found in
// Xero by reference — rather than creating a duplicate.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    entranceFee: { findFirst: vi.fn().mockResolvedValue(null) },
    member: { findUnique: vi.fn() },
    familyGroupMember: { findMany: vi.fn().mockResolvedValue([]) },
    xeroItemCodeMapping: { findFirst: vi.fn() },
    xeroAccountMapping: { findUnique: vi.fn() },
    xeroObjectLink: { findFirst: vi.fn() },
    xeroSyncOperation: { findFirst: vi.fn(), update: vi.fn() },
  },
}));

const mockCompleteXeroSyncOperation = vi.fn();
const mockStartXeroSyncOperation = vi.fn();
vi.mock("@/lib/xero-sync", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-sync");
  return {
    ...actual,
    completeXeroSyncOperation: (...args: unknown[]) =>
      mockCompleteXeroSyncOperation(...args),
    startXeroSyncOperation: (...args: unknown[]) =>
      mockStartXeroSyncOperation(...args),
    failXeroSyncOperation: vi.fn(),
  };
});

// Adopt-by-reference reads Xero; the durable-link case must never reach it, so
// default to rejecting and let the reference test override per-call.
const mockGetAuthenticatedXeroClient = vi.fn();
vi.mock("@/lib/xero-api-client", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-api-client");
  return {
    ...actual,
    // Run the wrapped call directly; the real wrapper persists metered usage to
    // prisma, which is not modelled in this unit test.
    callXeroApi: (fn: () => unknown) => fn(),
    getAuthenticatedXeroClient: (...args: unknown[]) =>
      mockGetAuthenticatedXeroClient(...args),
  };
});

vi.mock("@/lib/xero-mappings", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-mappings");
  return {
    ...actual,
    getResolvedAccountMapping: vi
      .fn()
      .mockResolvedValue({ code: "200", codeExplicitlyConfigured: false }),
  };
});

const mockFindOrCreateXeroContact = vi.fn();
const mockRetryXeroWriteWithContactRepair = vi.fn();
vi.mock("@/lib/xero-contacts", () => ({
  findOrCreateXeroContact: (...args: unknown[]) =>
    mockFindOrCreateXeroContact(...args),
  retryXeroWriteWithContactRepair: (...args: unknown[]) =>
    mockRetryXeroWriteWithContactRepair(...args),
}));

vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// F21 (#1886) observability: the conflict branches complete the op as SUCCEEDED
// and mint nothing, so the unbilled member is otherwise invisible. They must
// raise the existing money-anomaly alert primitive so an operator can find them.
const mockNotifyXeroSyncError = vi.fn();
vi.mock("@/lib/xero-error-alert", () => ({
  notifyXeroSyncError: (...args: unknown[]) => mockNotifyXeroSyncError(...args),
}));

import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { createXeroEntranceFeeInvoice } from "@/lib/xero-entrance-fee-invoices";
import { buildEntranceFeeInvoiceMintIdempotencyKey } from "@/lib/xero-mappings";

const ADULT_FEE = {
  category: "ADULT" as const,
  feeMapping: { itemCode: null, amountCents: 10000 },
};

// A full provider-detail invoice the adopt-by-reference path will accept: this
// member's contact, AUTHORISED, ACCREC, matching amount. Overridable per test.
function providerInvoice(overrides: Record<string, unknown> = {}) {
  return {
    invoiceID: "inv-xero",
    invoiceNumber: "INV-XERO",
    status: "AUTHORISED",
    type: "ACCREC",
    contact: { contactID: "contact-1" },
    total: 100, // 10000 cents, matches ADULT_FEE
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.familyGroupMember.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.member.findUnique).mockResolvedValue({
    ageTier: "ADULT",
  } as never);
  vi.mocked(prisma.xeroSyncOperation.update).mockResolvedValue({} as never);
  mockGetAuthenticatedXeroClient.mockRejectedValue(
    new Error("Xero must not be reached in the durable-link case"),
  );
});

describe("createXeroEntranceFeeInvoice double-mint guard (F21)", () => {
  it("adopts the already-linked invoice instead of minting a second (durable-link re-check)", async () => {
    // First mint already wrote the ENTRANCE_FEE_INVOICE link. A second worker
    // run (e.g. an amount-override re-enqueue with a fresh correlation key)
    // must adopt it, not mint again.
    vi.mocked(prisma.xeroObjectLink.findFirst).mockResolvedValue({
      xeroObjectId: "inv-existing",
      xeroObjectNumber: "INV-001",
      xeroObjectUrl: "https://xero/inv-existing",
    } as never);

    const result = await createXeroEntranceFeeInvoice("member-1", {
      syncOperationId: "op-second",
      precomputedEntranceFee: ADULT_FEE,
    });

    expect(result).toBe("inv-existing");
    // No mint, and Xero was never even contacted.
    expect(mockRetryXeroWriteWithContactRepair).not.toHaveBeenCalled();
    expect(mockGetAuthenticatedXeroClient).not.toHaveBeenCalled();
    expect(mockCompleteXeroSyncOperation).toHaveBeenCalledWith("op-second", {
      responsePayload: expect.objectContaining({ adopted: true }),
      xeroObjectType: "INVOICE",
      xeroObjectId: "inv-existing",
      xeroObjectNumber: "INV-001",
      xeroObjectUrl: "https://xero/inv-existing",
    });
  });

  it("adopts a prior mint found in Xero by reference when no link exists yet", async () => {
    // The link write crashed after the first mint, so no durable link exists,
    // but Xero already holds the invoice under its stable reference.
    vi.mocked(prisma.xeroObjectLink.findFirst).mockResolvedValue(null);
    mockFindOrCreateXeroContact.mockResolvedValue("contact-1");

    const getInvoices = vi.fn().mockResolvedValue({
      body: { invoices: [providerInvoice()] },
    });
    const createInvoices = vi.fn();
    mockGetAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi: { getInvoices, createInvoices } },
      tenantId: "tenant-1",
    });

    const result = await createXeroEntranceFeeInvoice("member-1", {
      syncOperationId: "op-second",
      precomputedEntranceFee: ADULT_FEE,
    });

    expect(result).toBe("inv-xero");
    // Looked the reference up, found one, and did NOT mint a second.
    expect(getInvoices).toHaveBeenCalledTimes(1);
    expect(getInvoices).toHaveBeenCalledWith(
      "tenant-1",
      undefined,
      'Reference=="Entrance fee (Adult) - member-1"',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      false,
    );
    // The mint runs inside the mocked retry wrapper, so asserting on the raw
    // createInvoices mock is vacuous (finding #5); assert the wrapper instead.
    expect(mockRetryXeroWriteWithContactRepair).not.toHaveBeenCalled();
    // Adoption backfills the durable ENTRANCE_FEE_INVOICE link.
    expect(mockCompleteXeroSyncOperation).toHaveBeenCalledWith(
      "op-second",
      expect.objectContaining({
        xeroObjectId: "inv-xero",
        extraLinks: expect.arrayContaining([
          expect.objectContaining({
            role: "ENTRANCE_FEE_INVOICE",
            xeroObjectId: "inv-xero",
            localModel: "Member",
            localId: "member-1",
          }),
        ]),
      }),
    );
  });

  it("adopts a PRE-RENAME minted invoice by its frozen reference, never re-minting (#1931)", async () => {
    // The joining-fee rename (E5) keeps the Xero reference format frozen at
    // `Entrance fee (<Label>) - <memberId>`. A member invoiced BEFORE the rename
    // holds an AUTHORISED invoice under exactly that reference. After the
    // rename, if the durable link is missing (crash window), the worker must
    // look the frozen reference up and adopt that pre-rename invoice rather than
    // mint a second one.
    vi.mocked(prisma.xeroObjectLink.findFirst).mockResolvedValue(null);
    mockFindOrCreateXeroContact.mockResolvedValue("contact-1");

    const preRenameInvoice = providerInvoice({ invoiceID: "inv-pre-rename", invoiceNumber: "INV-PRE" });
    const getInvoices = vi.fn().mockResolvedValue({ body: { invoices: [preRenameInvoice] } });
    const createInvoices = vi.fn();
    mockGetAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi: { getInvoices, createInvoices } },
      tenantId: "tenant-1",
    });

    const result = await createXeroEntranceFeeInvoice("member-1", {
      syncOperationId: "op-post-rename",
      precomputedEntranceFee: ADULT_FEE,
    });

    expect(result).toBe("inv-pre-rename");
    // Looked up the FROZEN reference format (unchanged by the rename).
    expect(getInvoices).toHaveBeenCalledWith(
      "tenant-1", undefined, 'Reference=="Entrance fee (Adult) - member-1"',
      undefined, undefined, undefined, undefined, undefined, 1, false,
    );
    // Adopted, not re-minted.
    expect(mockRetryXeroWriteWithContactRepair).not.toHaveBeenCalled();
    expect(createInvoices).not.toHaveBeenCalled();
    expect(mockCompleteXeroSyncOperation).toHaveBeenCalledWith(
      "op-post-rename",
      expect.objectContaining({ xeroObjectId: "inv-pre-rename" }),
    );
  });

  it("adopts a pre-rename FAMILY-labelled invoice when the member now classifies as ADULT (label-flip dual-read, #1931)", async () => {
    // E5 deliberately flips the category label for composition-family adults:
    // the OLD classifier billed them as FAMILY, the NEW type-driven classifier
    // says ADULT. The frozen reference embeds the label, so the new-label
    // lookup misses the pre-rename mint; if the durable link is also missing,
    // only the legacy-label dual-read stands between this member and a second
    // invoice. The worker must query BOTH references and adopt the pre-rename
    // FAMILY-labelled invoice.
    vi.mocked(prisma.xeroObjectLink.findFirst).mockResolvedValue(null);
    mockFindOrCreateXeroContact.mockResolvedValue("contact-1");
    // member-1 is an ADULT in a family group with >=2 adults and a dependent —
    // exactly the cohort the OLD composition heuristic classified as FAMILY.
    vi.mocked(prisma.familyGroupMember.findMany).mockImplementation(
      (async (args: { where?: { memberId?: string; familyGroupId?: string } }) => {
        if (args?.where?.memberId) return [{ familyGroupId: "fg-1" }];
        return [
          { member: { ageTier: "ADULT" } },
          { member: { ageTier: "ADULT" } },
          { member: { ageTier: "CHILD" } },
        ];
      }) as never,
    );

    const preRenameFamilyInvoice = providerInvoice({
      invoiceID: "inv-family-pre-rename",
      invoiceNumber: "INV-FAM",
    });
    const getInvoices = vi.fn(
      async (_tenantId: string, _ifModified: unknown, whereFilter: string) => {
        if (whereFilter === 'Reference=="Entrance fee (Family) - member-1"') {
          return { body: { invoices: [preRenameFamilyInvoice] } };
        }
        return { body: { invoices: [] } };
      },
    );
    const createInvoices = vi.fn();
    mockGetAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi: { getInvoices, createInvoices } },
      tenantId: "tenant-1",
    });

    const result = await createXeroEntranceFeeInvoice("member-1", {
      syncOperationId: "op-post-rename",
      precomputedEntranceFee: ADULT_FEE, // new classifier: ADULT, 10000c
    });

    expect(result).toBe("inv-family-pre-rename");
    // Both the frozen NEW-label reference and the legacy-label reference were
    // consulted; the pre-rename invoice was ADOPTED, not re-minted.
    expect(getInvoices).toHaveBeenCalledTimes(2);
    expect(getInvoices).toHaveBeenCalledWith(
      "tenant-1", undefined, 'Reference=="Entrance fee (Adult) - member-1"',
      undefined, undefined, undefined, undefined, undefined, 1, false,
    );
    expect(getInvoices).toHaveBeenCalledWith(
      "tenant-1", undefined, 'Reference=="Entrance fee (Family) - member-1"',
      undefined, undefined, undefined, undefined, undefined, 1, false,
    );
    expect(mockRetryXeroWriteWithContactRepair).not.toHaveBeenCalled();
    expect(createInvoices).not.toHaveBeenCalled();
    expect(mockCompleteXeroSyncOperation).toHaveBeenCalledWith(
      "op-post-rename",
      expect.objectContaining({
        xeroObjectId: "inv-family-pre-rename",
        extraLinks: expect.arrayContaining([
          expect.objectContaining({
            role: "ENTRANCE_FEE_INVOICE",
            xeroObjectId: "inv-family-pre-rename",
            localId: "member-1",
          }),
        ]),
      }),
    );
  });

  it("does not run the legacy-label lookup when old and new labels agree (single reference query)", async () => {
    // A plain adult with no qualifying family composition classifies ADULT
    // under BOTH classifiers — the dual-read must not add a second Xero query.
    vi.mocked(prisma.xeroObjectLink.findFirst).mockResolvedValue(null);
    mockFindOrCreateXeroContact.mockResolvedValue("contact-1");

    const getInvoices = vi.fn().mockResolvedValue({ body: { invoices: [] } });
    mockGetAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi: { getInvoices, createInvoices: vi.fn() } },
      tenantId: "tenant-1",
    });
    mockRetryXeroWriteWithContactRepair.mockResolvedValue({
      body: { invoices: [{ invoiceID: "inv-new", invoiceNumber: "INV-NEW" }] },
    });

    await createXeroEntranceFeeInvoice("member-1", {
      syncOperationId: "op-first",
      precomputedEntranceFee: ADULT_FEE,
    });

    expect(getInvoices).toHaveBeenCalledTimes(1);
    expect(getInvoices).toHaveBeenCalledWith(
      "tenant-1", undefined, 'Reference=="Entrance fee (Adult) - member-1"',
      undefined, undefined, undefined, undefined, undefined, 1, false,
    );
  });

  it("hard-stops (PROVIDER_MISMATCH) on a legacy-label invoice whose amount differs, minting nothing", async () => {
    // The pre-rename FAMILY invoice exists but at a different amount than the
    // member's new ADULT fee. Ambiguous money: never silently adopt a
    // wrong-amount invoice and never mint a second — surface the conflict.
    vi.mocked(prisma.xeroObjectLink.findFirst).mockResolvedValue(null);
    mockFindOrCreateXeroContact.mockResolvedValue("contact-1");
    vi.mocked(prisma.familyGroupMember.findMany).mockImplementation(
      (async (args: { where?: { memberId?: string; familyGroupId?: string } }) => {
        if (args?.where?.memberId) return [{ familyGroupId: "fg-1" }];
        return [
          { member: { ageTier: "ADULT" } },
          { member: { ageTier: "ADULT" } },
          { member: { ageTier: "YOUTH" } },
        ];
      }) as never,
    );

    const getInvoices = vi.fn(
      async (_tenantId: string, _ifModified: unknown, whereFilter: string) => {
        if (whereFilter === 'Reference=="Entrance fee (Family) - member-1"') {
          // 20000 cents ≠ the expected 10000c ADULT fee.
          return { body: { invoices: [providerInvoice({ total: 200 })] } };
        }
        return { body: { invoices: [] } };
      },
    );
    mockGetAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi: { getInvoices, createInvoices: vi.fn() } },
      tenantId: "tenant-1",
    });

    const result = await createXeroEntranceFeeInvoice("member-1", {
      syncOperationId: "op-post-rename",
      precomputedEntranceFee: ADULT_FEE,
    });

    expect(result).toBeNull();
    expect(mockRetryXeroWriteWithContactRepair).not.toHaveBeenCalled();
    expect(mockCompleteXeroSyncOperation).toHaveBeenCalledWith(
      "op-post-rename",
      expect.objectContaining({
        status: "SUCCEEDED",
        responsePayload: expect.objectContaining({
          conflict: "PROVIDER_MISMATCH",
          expectedAmountCents: 10000,
        }),
      }),
    );
    expect(mockNotifyXeroSyncError).toHaveBeenCalledWith(
      expect.objectContaining({ errorType: "entrance-fee-provider-mismatch" }),
    );
  });

  it("mints exactly once when no link and no prior Xero invoice exist", async () => {
    // Baseline: the guards must not block the legitimate first mint.
    vi.mocked(prisma.xeroObjectLink.findFirst).mockResolvedValue(null);
    mockFindOrCreateXeroContact.mockResolvedValue("contact-1");

    const getInvoices = vi.fn().mockResolvedValue({ body: { invoices: [] } });
    const createInvoices = vi.fn();
    mockGetAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi: { getInvoices, createInvoices } },
      tenantId: "tenant-1",
    });
    mockRetryXeroWriteWithContactRepair.mockResolvedValue({
      body: { invoices: [{ invoiceID: "inv-new", invoiceNumber: "INV-NEW" }] },
    });

    const result = await createXeroEntranceFeeInvoice("member-1", {
      syncOperationId: "op-first",
      precomputedEntranceFee: ADULT_FEE,
    });

    expect(result).toBe("inv-new");
    expect(getInvoices).toHaveBeenCalledTimes(1);
    expect(mockRetryXeroWriteWithContactRepair).toHaveBeenCalledTimes(1);
    expect(mockCompleteXeroSyncOperation).toHaveBeenCalledWith(
      "op-first",
      expect.objectContaining({ xeroObjectId: "inv-new" }),
    );
  });

  it("does NOT adopt an invoice whose contact is a different member (reference collision)", async () => {
    // Finding #1: the Reference field alone is not proof of ownership. An
    // invoice found by reference but belonging to another member's contact must
    // never be adopted (that would leave the victim unbilled and cross-wire the
    // link). We mint our own instead.
    vi.mocked(prisma.xeroObjectLink.findFirst).mockResolvedValue(null);
    mockFindOrCreateXeroContact.mockResolvedValue("contact-1");

    const getInvoices = vi.fn().mockResolvedValue({
      body: {
        invoices: [providerInvoice({ contact: { contactID: "other-contact" } })],
      },
    });
    mockGetAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi: { getInvoices, createInvoices: vi.fn() } },
      tenantId: "tenant-1",
    });
    mockRetryXeroWriteWithContactRepair.mockResolvedValue({
      body: { invoices: [{ invoiceID: "inv-new", invoiceNumber: "INV-NEW" }] },
    });

    const result = await createXeroEntranceFeeInvoice("member-1", {
      syncOperationId: "op-second",
      precomputedEntranceFee: ADULT_FEE,
    });

    // Minted our own; did not adopt the other member's invoice.
    expect(result).toBe("inv-new");
    expect(mockRetryXeroWriteWithContactRepair).toHaveBeenCalledTimes(1);
    expect(mockCompleteXeroSyncOperation).toHaveBeenCalledWith(
      "op-second",
      expect.objectContaining({ xeroObjectId: "inv-new" }),
    );
  });

  it("does NOT adopt a VOIDED invoice; re-issues instead", async () => {
    // Finding #3: guard 2 must ignore non-AUTHORISED invoices so a VOIDED (or
    // DELETED/DRAFT) invoice cannot suppress a legitimate re-issue.
    vi.mocked(prisma.xeroObjectLink.findFirst).mockResolvedValue(null);
    mockFindOrCreateXeroContact.mockResolvedValue("contact-1");

    const getInvoices = vi.fn().mockResolvedValue({
      body: { invoices: [providerInvoice({ status: "VOIDED" })] },
    });
    mockGetAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi: { getInvoices, createInvoices: vi.fn() } },
      tenantId: "tenant-1",
    });
    mockRetryXeroWriteWithContactRepair.mockResolvedValue({
      body: { invoices: [{ invoiceID: "inv-new", invoiceNumber: "INV-NEW" }] },
    });

    const result = await createXeroEntranceFeeInvoice("member-1", {
      syncOperationId: "op-second",
      precomputedEntranceFee: ADULT_FEE,
    });

    expect(result).toBe("inv-new");
    expect(mockRetryXeroWriteWithContactRepair).toHaveBeenCalledTimes(1);
  });

  it("surfaces a DUPLICATE_REFERENCE conflict when >1 AUTHORISED invoice shares the reference", async () => {
    // Finding #4: mirror the subscription path — a real duplicate needs human
    // reconciliation, not a silent adopt-first.
    vi.mocked(prisma.xeroObjectLink.findFirst).mockResolvedValue(null);
    mockFindOrCreateXeroContact.mockResolvedValue("contact-1");

    const createInvoices = vi.fn();
    const getInvoices = vi.fn().mockResolvedValue({
      body: {
        invoices: [
          providerInvoice({ invoiceID: "inv-a", invoiceNumber: "INV-A" }),
          providerInvoice({ invoiceID: "inv-b", invoiceNumber: "INV-B" }),
        ],
      },
    });
    mockGetAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi: { getInvoices, createInvoices } },
      tenantId: "tenant-1",
    });

    const result = await createXeroEntranceFeeInvoice("member-1", {
      syncOperationId: "op-second",
      precomputedEntranceFee: ADULT_FEE,
    });

    expect(result).toBeNull();
    // No mint, and a conflict is surfaced for reconciliation.
    expect(mockRetryXeroWriteWithContactRepair).not.toHaveBeenCalled();
    expect(mockCompleteXeroSyncOperation).toHaveBeenCalledWith(
      "op-second",
      expect.objectContaining({
        status: "SUCCEEDED",
        responsePayload: expect.objectContaining({
          conflict: "DUPLICATE_REFERENCE",
          invoiceCount: 2,
        }),
      }),
    );

    // MED (#1886): the op completes green, so the unbilled member must be made
    // operator-visible. A structured ERROR log names the member, reference,
    // conflict code, and the offending invoice ids...
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        memberId: "member-1",
        reference: "Entrance fee (Adult) - member-1",
        conflict: "DUPLICATE_REFERENCE",
        invoiceIds: ["inv-a", "inv-b"],
      }),
      expect.any(String),
    );
    // ...and the existing money-anomaly alert primitive is raised.
    expect(mockNotifyXeroSyncError).toHaveBeenCalledWith(
      expect.objectContaining({
        errorType: "entrance-fee-duplicate-reference",
        operation: expect.stringContaining("member-1"),
        errorMessage: expect.stringContaining("inv-a"),
      }),
    );
  });

  it("surfaces a PROVIDER_MISMATCH conflict for a same-member wrong-amount invoice", async () => {
    // Finding #3/#1: a same-member AUTHORISED invoice on this reference but with
    // the wrong amount is ambiguous — surface a conflict rather than adopt a
    // wrong-amount invoice or mint a duplicate.
    vi.mocked(prisma.xeroObjectLink.findFirst).mockResolvedValue(null);
    mockFindOrCreateXeroContact.mockResolvedValue("contact-1");

    const getInvoices = vi.fn().mockResolvedValue({
      body: { invoices: [providerInvoice({ total: 200 })] }, // 20000 cents ≠ 10000
    });
    mockGetAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi: { getInvoices, createInvoices: vi.fn() } },
      tenantId: "tenant-1",
    });

    const result = await createXeroEntranceFeeInvoice("member-1", {
      syncOperationId: "op-second",
      precomputedEntranceFee: ADULT_FEE,
    });

    expect(result).toBeNull();
    expect(mockRetryXeroWriteWithContactRepair).not.toHaveBeenCalled();
    expect(mockCompleteXeroSyncOperation).toHaveBeenCalledWith(
      "op-second",
      expect.objectContaining({
        status: "SUCCEEDED",
        responsePayload: expect.objectContaining({
          conflict: "PROVIDER_MISMATCH",
          expectedAmountCents: 10000,
        }),
      }),
    );

    // MED (#1886): make the unbilled member operator-visible behind the green op.
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        memberId: "member-1",
        reference: "Entrance fee (Adult) - member-1",
        conflict: "PROVIDER_MISMATCH",
        invoiceId: "inv-xero",
        expectedAmountCents: 10000,
        providerAmountCents: 20000,
      }),
      expect.any(String),
    );
    expect(mockNotifyXeroSyncError).toHaveBeenCalledWith(
      expect.objectContaining({
        errorType: "entrance-fee-provider-mismatch",
        operation: expect.stringContaining("member-1"),
        errorMessage: expect.stringContaining("inv-xero"),
      }),
    );
  });

  it("uses a member-scoped Xero mint idempotency key that does not vary with amount (concurrent double-mint convergence)", async () => {
    // Finding #2: two operations racing for one member (different amounts, so
    // distinct correlation keys) must converge on ONE Xero invoice. The
    // mechanism is a member-scoped createInvoices idempotency key — Xero returns
    // the first invoice for the second request. Prove the key is member-scoped
    // and identical across differing amounts (mirrors the F7/#1355 contact
    // idempotency-key convergence, without holding a DB lock across the mint).
    vi.mocked(prisma.xeroObjectLink.findFirst).mockResolvedValue(null);
    mockFindOrCreateXeroContact.mockResolvedValue("contact-1");

    const capturedKeys: unknown[] = [];
    const createInvoices = vi.fn((..._args: unknown[]) => {
      capturedKeys.push(_args[4]);
      return Promise.resolve({
        body: { invoices: [{ invoiceID: "inv-new", invoiceNumber: "INV-NEW" }] },
      });
    });
    const getInvoices = vi.fn().mockResolvedValue({ body: { invoices: [] } });
    mockGetAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi: { getInvoices, createInvoices } },
      tenantId: "tenant-1",
    });
    // Drive the real mint closure so the idempotency key reaches createInvoices.
    mockRetryXeroWriteWithContactRepair.mockImplementation((opts: never) =>
      (opts as { run: (i: { contactId: string }) => unknown }).run({
        contactId: "contact-1",
      }),
    );

    await createXeroEntranceFeeInvoice("member-1", {
      syncOperationId: "op-a",
      precomputedEntranceFee: ADULT_FEE,
    });
    await createXeroEntranceFeeInvoice("member-1", {
      syncOperationId: "op-b",
      // A different amount override — the enqueue-time dedupe would NOT catch
      // this, but the mint key must still be identical.
      precomputedEntranceFee: {
        category: "ADULT" as const,
        feeMapping: { itemCode: null, amountCents: 15000 },
      },
    });

    const expectedKey = buildEntranceFeeInvoiceMintIdempotencyKey("member-1");
    expect(capturedKeys).toEqual([expectedKey, expectedKey]);
  });
});
