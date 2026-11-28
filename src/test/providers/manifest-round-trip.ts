import type { MemberMoneyAccount, MemberMoneyExportDocumentRole, Prisma, PrismaClient } from "@prisma/client";
import { expect } from "vitest";
import type { LineItem } from "xero-node";
import { providerAmountToCents } from "@/lib/money-provider-amount";

/**
 * THE EXPORT MANIFEST'S ROUND-TRIP PROOF ON THE PROVIDER FAKES (#4525, Ledger
 * M13; ALP-753). A suite sends a document through the app's own Xero sender
 * over `xeroTransport` (`setXeroClientForTests`), then reads it back through
 * the app's own client and holds the manifest the sender recorded to what Xero
 * holds: the coverage adds up to the document's lines exactly, and each group
 * of lines (the stay lines, the change-fee line, a refund note's whole) to the
 * cover of its own account.
 *
 * Document-generic on purpose: a booking invoice, an edit's credit note, a
 * refund note, its payment and a failed-later reversal all read back as lines
 * and a total, so the sibling round trips (#5278, #5287) can reuse this as it is.
 * The line total is worked out here, quantity times unit amount per line as
 * the transport totals it, never with the app's own totalling helper, so the
 * sender and this proof cannot agree by construction.
 */

type ReadBackDocumentKind = "INVOICE" | "CREDIT_NOTE";

/** A document as Xero holds it, read back through the app's client: its lines and Xero's own total. */
interface ReadBackDocument {
  kind: ReadBackDocumentKind;
  id: string;
  lineItems: LineItem[];
  totalCents: number;
}

/** Read one document back through `getAuthenticatedXeroClient`, as any app reader would. */
export async function readBackDocument(kind: ReadBackDocumentKind, id: string): Promise<ReadBackDocument> {
  // Loaded here, not at the top: the client reaches `@/lib/prisma`, which a suite points at its database first.
  const { getAuthenticatedXeroClient } = await import("@/lib/xero-api-client");
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const document = kind === "INVOICE"
    ? (await xero.accountingApi.getInvoice(tenantId, id)).body.invoices?.[0]
    : (await xero.accountingApi.getCreditNote(tenantId, id)).body.creditNotes?.[0];
  if (!document) throw new Error(`Xero holds no ${kind} ${id}`);
  const totalCents = providerAmountToCents(document.total);
  if (totalCents === null) throw new Error(`The ${kind} ${id} Xero holds carries no total`);
  return { kind, id, lineItems: document.lineItems ?? [], totalCents };
}

/** A line's cents as Xero totals it: quantity times unit amount, rounded to the cent. */
function lineCents(line: LineItem): number {
  const unitCents = providerAmountToCents(line.unitAmount);
  if (unitCents === null || line.quantity == null) throw new Error("A read-back line carries no quantity or unit amount");
  return Math.round(line.quantity * unitCents);
}

const MANIFEST_SELECT = {
  id: true,
  legacyKey: true,
  outcome: true,
  reason: true,
  lineTotalCents: true,
  providerInvoiceId: true,
  release: { select: { id: true } },
  coverage: {
    orderBy: [{ account: "asc" }, { sliceKey: "asc" }],
    select: { account: true, chargeIdentity: true, sliceKey: true, coveredCents: true },
  },
} satisfies Prisma.MemberMoneyExportManifestSelect;

type RecordedManifest = Awaited<ReturnType<typeof readManifests>>[number];

/** Every manifest recorded under `role` for one provider object, oldest key first. */
export async function readManifests(prisma: PrismaClient, role: MemberMoneyExportDocumentRole, providerId: string) {
  return prisma.memberMoneyExportManifest.findMany({
    where: { documentRole: role, providerInvoiceId: providerId },
    orderBy: { legacyKey: "asc" },
    select: MANIFEST_SELECT,
  });
}

/** The one manifest recorded under `role` for one provider object. */
export async function readManifest(prisma: PrismaClient, role: MemberMoneyExportDocumentRole, providerId: string): Promise<RecordedManifest> {
  const manifests = await readManifests(prisma, role, providerId);
  expect(manifests, `${role} manifests recorded for ${providerId}`).toHaveLength(1);
  return manifests[0]!;
}

/** One group of a document's lines and the account whose cover must carry exactly their cents. */
interface CoverageLineGroup {
  account: MemberMoneyAccount;
  lines: (line: LineItem) => boolean;
}

/**
 * The manifest covers exactly what Xero holds: COVERED, its line total and its
 * coverage both equal to the read-back lines' total, which is Xero's own
 * total; and, when `groups` are given, each group's lines equal to the cover
 * of its account, every line in one group and every covered account named.
 */
export function expectCoverageEqualsLines(document: ReadBackDocument, manifest: RecordedManifest, groups?: readonly CoverageLineGroup[]): void {
  const what = `${document.kind} ${document.id}`;
  const total = document.lineItems.reduce((sum, line) => sum + lineCents(line), 0);
  expect(total, `${what}: its lines add up to Xero's own total`).toBe(document.totalCents);
  expect(manifest, `${what}: its manifest covers it`).toMatchObject({ outcome: "COVERED", reason: null, lineTotalCents: total, providerInvoiceId: document.id });
  expect(manifest.coverage.reduce((sum, row) => sum + row.coveredCents, 0), `${what}: its coverage adds up to its lines`).toBe(total);
  if (!groups) return;
  for (const line of document.lineItems) {
    expect(groups.filter((group) => group.lines(line)), `${what}: line "${line.description}" belongs to exactly one group`).toHaveLength(1);
  }
  for (const group of groups) {
    const linesCents = document.lineItems.filter(group.lines).reduce((sum, line) => sum + lineCents(line), 0);
    const covered = manifest.coverage.filter((row) => row.account === group.account).reduce((sum, row) => sum + row.coveredCents, 0);
    expect(covered, `${what}: the ${group.account} cover equals its lines`).toBe(linesCents);
  }
  const named = new Set(groups.map((group) => group.account));
  expect(manifest.coverage.filter((row) => !named.has(row.account)), `${what}: no cover outside the named groups`).toEqual([]);
}
