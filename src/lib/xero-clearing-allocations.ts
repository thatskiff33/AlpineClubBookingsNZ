/**
 * Where an invoice-clearing credit note is allocated (`INV-PAY-017`, #3535).
 *
 * The note is sized over the booking's whole invoicing — the primary invoice
 * plus, for a booking edited upward, the booking change's supplementary
 * invoice, which also carries the change fee (`unpaidInvoiceClearingAmountCents`).
 * Allocating all of it to the primary invoice asked Xero to allocate more than
 * that invoice owes, so Xero refused and the note floated with both invoices
 * open. The note is therefore allocated across the booking's open invoices,
 * the primary first and then each supplementary invoice in the order it was
 * raised, each up to what Xero says it still owes.
 *
 * When those invoices together owe LESS than the note — part of the booking
 * was paid, or an invoice the note is sized for was never raised — nothing is
 * allocated and no note is created: the builder fails the operation with the
 * shortfall, visibly, rather than leaving a note that says the booking was not
 * paid floating against money that was (a part-paid invoice is #3643's).
 *
 * The plan is recorded on the operation (`allocations`), so a PARTIAL note's
 * repair re-allocates exactly what was planned instead of re-deriving it from
 * invoices the first attempt already changed.
 */
import type { XeroClient } from "xero-node";
import { prisma } from "@/lib/prisma";
import { callXeroApi } from "@/lib/xero-api-client";
import { providerAmountToCents } from "@/lib/money-provider-amount";
import { asRecord, readNumber, readString } from "@/lib/xero-json";
import { formatCents } from "@/lib/utils";
import { REDACTED_SECRET } from "@/lib/redact-sensitive-json";
import { XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE } from "@/lib/xero-operation-outbox-payload";
import {
  readModificationNoteWording,
  type ModificationNoteWording,
} from "@/lib/xero-refund-method";
import type { ClubFormat } from "@/lib/club-format";

export interface ClearingAllocationTarget {
  invoiceId: string;
  amountCents: number;
}

/** The fixed opening of the shortfall message, which the repair tool reads back. */
const CLEARING_ALLOCATION_SHORTFALL_MARKER = "The booking's open Xero invoices owe ";

/**
 * A FAILED clearing row whose error is the shortfall: the invoices owe less
 * than the note, so retrying it changes nothing until a person looks. The
 * repair tool never offers it as a safe auto-retry.
 */
export function isClearingAllocationShortfall(message: string | null | undefined): boolean {
  return typeof message === "string" && message.startsWith(CLEARING_ALLOCATION_SHORTFALL_MARKER);
}

export class ClearingAllocationShortfallError extends Error {
  constructor(noteCents: number, owedCents: number, format: ClubFormat) {
    super(
      `${CLEARING_ALLOCATION_SHORTFALL_MARKER}${formatCents(owedCents, format)}, less than this ${formatCents(noteCents, format)} invoice-clearing credit note; nothing was created. Part of the booking may have been paid, or an invoice the note is sized for was never raised - review it by hand.`
    );
    this.name = "ClearingAllocationShortfallError";
  }
}

/**
 * Pure: allocate `noteCents` across `invoices` in order, each up to its amount
 * due. Throws when they owe less than the note in total.
 */
export function planClearingAllocations(input: {
  noteCents: number;
  invoices: Array<{ invoiceId: string; amountDueCents: number }>;
  /** The club's format (#3565), for the shortfall message's amounts. */
  format: ClubFormat;
}): ClearingAllocationTarget[] {
  const targets: ClearingAllocationTarget[] = [];
  let remaining = input.noteCents;
  for (const invoice of input.invoices) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, Math.max(0, invoice.amountDueCents));
    if (take > 0) {
      targets.push({ invoiceId: invoice.invoiceId, amountCents: take });
      remaining -= take;
    }
  }
  if (remaining > 0) {
    throw new ClearingAllocationShortfallError(
      input.noteCents,
      input.noteCents - remaining,
      input.format
    );
  }
  return targets;
}

/**
 * The booking changes' own supplementary invoices, oldest first. A review
 * task's second ask (anchored on the task, #3193) bills money outside the
 * booking's stored price, so the clearing note is not sized for it.
 */
export async function findBookingSupplementaryInvoiceIds(
  bookingId: string
): Promise<string[]> {
  const modifications = await prisma.bookingModification.findMany({
    where: { bookingId },
    select: { id: true },
  });
  if (modifications.length === 0) return [];
  const links = await prisma.xeroObjectLink.findMany({
    where: {
      localModel: "BookingModification",
      localId: { in: modifications.map((modification) => modification.id) },
      xeroObjectType: "INVOICE",
      role: "SUPPLEMENTARY_INVOICE",
      active: true,
    },
    select: { xeroObjectId: true },
    orderBy: { createdAt: "asc" },
  });
  return [...new Set(links.map((link) => link.xeroObjectId))];
}

/** Each invoice's live amount due, in the order given; 0 unless AUTHORISED. */
export async function readInvoiceAmountsDue(
  xero: XeroClient,
  tenantId: string,
  invoiceIds: string[]
): Promise<Array<{ invoiceId: string; amountDueCents: number }>> {
  const out: Array<{ invoiceId: string; amountDueCents: number }> = [];
  for (const invoiceId of invoiceIds) {
    const response = await callXeroApi(
      () => xero.accountingApi.getInvoice(tenantId, invoiceId),
      {
        operation: "getInvoice",
        resourceType: "INVOICE",
        workflow: "createXeroCreditNoteForModification",
        context: `getInvoice(clearing allocation ${invoiceId})`,
      }
    );
    const invoice = response.body.invoices?.[0];
    const authorised = String(invoice?.status ?? "") === "AUTHORISED";
    out.push({
      invoiceId,
      amountDueCents: authorised ? providerAmountToCents(invoice?.amountDue) ?? 0 : 0,
    });
  }
  return out;
}

/**
 * A recorded plan whose invoice id was redacted on the way into storage cannot
 * be replayed: allocating against "[REDACTED]" would fail at best. Refused
 * loudly so a person looks at the row (#3535; the UUID redaction bug that
 * caused it is fixed in `redact-sensitive-json.ts`, but rows written before
 * that fix may still carry it).
 */
export class RedactedClearingPlanError extends Error {
  constructor() {
    super(
      "This clearing note's recorded allocation plan has a redacted invoice id, so it cannot be replayed - allocate the note to the booking's invoices by hand in Xero."
    );
    this.name = "RedactedClearingPlanError";
  }
}

/**
 * The plan a clearing note's operation recorded, or null when it recorded none.
 * Throws `RedactedClearingPlanError` when an invoice id in it was redacted.
 */
export function readRecordedClearingAllocations(
  requestPayload: unknown
): ClearingAllocationTarget[] | null {
  const raw = asRecord(requestPayload)?.allocations;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const targets: ClearingAllocationTarget[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    const invoiceId = readString(record?.invoiceId);
    const amountCents = readNumber(record?.amountCents);
    if (invoiceId === REDACTED_SECRET) throw new RedactedClearingPlanError();
    if (!invoiceId || amountCents === null || amountCents <= 0) return null;
    targets.push({ invoiceId, amountCents });
  }
  return targets;
}

/**
 * A FAILED booking-anchored clearing note (the hold-expiry release's, the
 * never-captured cancel path's, the repair tool's re-queue) replays from what
 * its own row recorded: the amount, and the wording through the one reader, so
 * a replay still says the invoice was cleared. Both the queued shape and the
 * builder's execution shape keep `refundAmountCents`; the builder re-plans the
 * allocations, since a FAILED row created no note to allocate.
 */
export function readBookingClearingNoteRetryInput(operation: {
  localModel: string | null;
  localId: string | null;
  requestPayload: unknown;
  queueType?: string | null;
}): { amountCents: number; wording: ModificationNoteWording } | null {
  if (operation.localModel !== "Booking" || !operation.localId) return null;
  const payload = asRecord(operation.requestPayload);
  const amountCents = readNumber(payload?.refundAmountCents);
  const isClearingNoteRow =
    payload?.queueType === XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE ||
    operation.queueType === XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE ||
    readString(payload?.invoiceId) !== null;
  if (!isClearingNoteRow || amountCents === null || amountCents <= 0) return null;
  return { amountCents, wording: readModificationNoteWording(payload) };
}

/** The role a note's own allocation links carry: the builder's, its PARTIAL retry's and the inbound mirror's. */
export const NOTE_ALLOCATION_ROLE = "MODIFICATION_CREDIT_NOTE_ALLOCATION";

/**
 * #4767: the role `allocateCreditNoteToInvoice` gives a link when its caller
 * names none. Before #4757 the repair tool could offer a note's own failed
 * allocation row its generic ALLOCATE retry, which links with this role.
 */
export const ROLELESS_ALLOCATION_ROLE = "CREDIT_NOTE_ALLOCATION";

/** The link roles that can show a note's planned target allocated (`linkAllocatesClearingTarget`). */
export const CLEARING_TARGET_LINK_ROLES: readonly string[] = [NOTE_ALLOCATION_ROLE, ROLELESS_ALLOCATION_ROLE];

/** An allocation link as the clearing readers see it. */
export interface ClearingAllocationLink {
  role: string | null;
  metadata: unknown;
}

/**
 * Pure (#4767, `INV-SSOT`): does this link show `target` allocated from
 * `creditNoteId`? The one rule the PARTIAL retry, the repair tool's PARTIAL
 * check and its own-row dispatcher share, so the retry and the report never
 * disagree. Either:
 *
 * - a link with the note's own role naming this note and the target's
 *   invoice - the rule since #4259; only the note's own writers give it that
 *   role, for a planned target; or
 * - a role-less `CREDIT_NOTE_ALLOCATION` link naming this note, the target's
 *   invoice AND its amount - Xero's allocation key (note, invoice, amount),
 *   which the note's retry would send again. Every writer of that role records
 *   the amount, so a link without one has no known writer and is not read as
 *   this allocation: the retry then sends it, and Xero refusing a duplicate
 *   leaves the row PARTIAL, visible, where reading it as done could close a
 *   note with an invoice still open.
 *
 * Read only: the role-less link is never re-roled. The role is part of the
 * link's unique key, so the inbound mirror of the note writes its own
 * role-carrying link for the same allocation beside it; the money readers
 * count the two as one (`distinctClearingAllocations`, #4786).
 */
export function linkAllocatesClearingTarget(
  link: ClearingAllocationLink,
  target: ClearingAllocationTarget,
  creditNoteId: string
): boolean {
  const metadata = asRecord(link.metadata);
  if (readString(metadata?.creditNoteId) !== creditNoteId || readString(metadata?.invoiceId) !== target.invoiceId) {
    return false;
  }
  if (link.role === NOTE_ALLOCATION_ROLE) return true;
  return link.role === ROLELESS_ALLOCATION_ROLE && readNumber(metadata?.amountCents) === target.amountCents;
}

/** One allocation of a credit note to an invoice, as a link records it. */
export interface ClearingAllocation<L extends ClearingAllocationLink = ClearingAllocationLink> {
  creditNoteId: string;
  invoiceId: string;
  /** Null only for a link with the note's own role that recorded no amount. */
  amountCents: number | null;
  /** The link it was read from: the last one given for that allocation. */
  link: L;
}

/**
 * Pure (#4786, `INV-SSOT`): the allocations these links record, each once, by
 * the rule `linkAllocatesClearingTarget` applies to a planned target. A link
 * counts when it carries the note's own role, or is a role-less
 * `CREDIT_NOTE_ALLOCATION` link that recorded its amount; any other role, or a
 * role-less link with no amount, counts nothing (fail closed, as the retry
 * does). Links naming the same note, invoice and amount - Xero's allocation key
 * - are one allocation, so the inbound mirror's own-role link and the role-less
 * one for the same allocation count once; a different amount is a different
 * allocation. Where several links hold one allocation the last given is kept.
 * With `creditNoteId`, only that note's allocations. Read only: the money
 * readers (the hold under-clear audit, the kept settle's correction count and
 * the refunded-total recount) count what this returns.
 */
export function distinctClearingAllocations<L extends ClearingAllocationLink>(
  links: readonly L[],
  creditNoteId?: string
): ClearingAllocation<L>[] {
  const byKey = new Map<string, ClearingAllocation<L>>();
  for (const link of links) {
    const metadata = asRecord(link.metadata);
    const noteId = readString(metadata?.creditNoteId);
    const invoiceId = readString(metadata?.invoiceId);
    if (!noteId || !invoiceId || (creditNoteId !== undefined && noteId !== creditNoteId)) continue;
    const amountCents = readNumber(metadata?.amountCents);
    // The link's own allocation as the target: the note's role needs only the
    // note and invoice; a role-less link's missing amount (NaN) never matches.
    if (!linkAllocatesClearingTarget(link, { invoiceId, amountCents: amountCents ?? Number.NaN }, noteId)) continue;
    const key = JSON.stringify([noteId, invoiceId, amountCents]);
    byKey.delete(key);
    byKey.set(key, { creditNoteId: noteId, invoiceId, amountCents, link });
  }
  return [...byKey.values()];
}

/**
 * Pure: the planned targets no allocation link shows allocated from this note
 * yet (`linkAllocatesClearingTarget`). The one predicate the PARTIAL repair and
 * the repair tool's PARTIAL check share, so a repaired note stops being
 * reported the moment it is whole.
 */
export function targetsWithoutAllocation(
  targets: ClearingAllocationTarget[],
  creditNoteId: string,
  allocationLinks: ClearingAllocationLink[]
): ClearingAllocationTarget[] {
  return targets.filter(
    (target) => !allocationLinks.some((link) => linkAllocatesClearingTarget(link, target, creditNoteId))
  );
}

/**
 * The targets a note's operation planned: its recorded plan, or (an edit's
 * note, or a row from before plans were recorded) its single invoice and
 * amount. Null when neither is readable; throws `RedactedClearingPlanError`
 * for a redacted plan.
 */
export function recordedClearingTargets(
  requestPayload: unknown
): ClearingAllocationTarget[] | null {
  const recorded = readRecordedClearingAllocations(requestPayload);
  if (recorded) return recorded;
  const payload = asRecord(requestPayload);
  const invoiceId = readString(payload?.invoiceId);
  const amountCents = readNumber(payload?.refundAmountCents);
  return invoiceId && amountCents !== null ? [{ invoiceId, amountCents }] : null;
}

/**
 * Does a PARTIAL note still have a planned invoice with no allocation link from
 * it? The repair tool's PARTIAL check; a row repaired before #4259, or whose
 * allocations were linked another way, stays PARTIAL until a retry closes it,
 * so status alone would report a whole note as broken forever. An unreadable (or
 * redacted) plan counts as incomplete; the retry meta then decides whether it
 * can be replayed.
 */
export function partialClearingNoteIsIncomplete(
  requestPayload: unknown,
  creditNoteId: string,
  allocationLinks: ClearingAllocationLink[]
): boolean {
  try {
    const targets = recordedClearingTargets(requestPayload);
    return !targets || targetsWithoutAllocation(targets, creditNoteId, allocationLinks).length > 0;
  } catch {
    return true;
  }
}

/**
 * The planned targets a PARTIAL note has not yet allocated: one whose
 * allocation link already exists is skipped, since re-allocating it would
 * exceed what that invoice now owes. Reads the note's own role and the
 * role-less one (#4767), and `linkAllocatesClearingTarget` decides.
 */
export async function unallocatedClearingTargets(input: {
  creditNoteId: string;
  targets: ClearingAllocationTarget[];
  localModel: string;
  localId: string;
}): Promise<ClearingAllocationTarget[]> {
  const links = await prisma.xeroObjectLink.findMany({
    where: {
      localModel: input.localModel,
      localId: input.localId,
      xeroObjectType: "ALLOCATION",
      role: { in: [...CLEARING_TARGET_LINK_ROLES] },
      active: true,
    },
    select: { role: true, metadata: true },
  });
  return targetsWithoutAllocation(input.targets, input.creditNoteId, links);
}
