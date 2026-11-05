/**
 * #4220 (lane a; owner decision, 24 Oct 2026): the summary of a credit note's spend
 * the app keeps with the note's existing link, from what Xero already sent.
 *
 * The inbound credit-note reconcile holds the whole note (status, total, remaining
 * credit, allocations, payments, change time). When the note funds a member's
 * credit lot it keeps that READING, in exact cents, under ONE key of the link's
 * metadata, so the early warning (`xero-credit-note-spent-outside-flag.ts`) can
 * judge it later from the database alone, with no Xero call. It stores the reading,
 * not a verdict: whether a spend is the app's own depends on local links that can
 * land after the reading, so the verdict is derived each time it is asked for.
 *
 * One key, replaced whole by the link funnel's top-level merge, so a later write
 * can never leave old allocations beside a newer total. A refund note's links never
 * carry it (a refund note funds no lot, and its snapshot has its own write order,
 * `judgeRefundNoteWrite`). Nothing here reads or writes Xero or the credit ledger.
 */
import type { Prisma } from "@prisma/client";
import { creditNoteMirrorEvidenceFrom, type CreditNoteMirrorEvidence, type XeroCreditNoteLike } from "@/lib/xero-credit-note-mirror";
import { NOT_A_CONVERGENCE_ROW } from "@/lib/xero-credit-note-write-down";
import { REFUND_NOTE_LINK_ROLES, isRefundNoteLinkOf } from "@/lib/xero-refund-note-status";
import type { XeroObjectLinkInput } from "@/lib/xero-sync";

/** The `XeroObjectLink.metadata` key holding the reading. */
export const CREDIT_NOTE_SPEND_EVIDENCE_KEY = "spendEvidence";

/** The reading as stored: JSON-safe, exact cents, instants as ISO strings. */
export interface StoredCreditNoteSpendEvidence {
  status: string | null;
  totalCents: number | null;
  remainingCents: number | null;
  allocations: Array<{ invoiceId: string; cents: number }>;
  payments: Array<{ paymentId: string; cents: number }>;
  /** Xero's `UpdatedDateUTC` for the reading, or null when Xero sent none. */
  noteUpdatedAt: string | null;
  /** When the app took the reading. */
  observedAt: string;
}

/** The reading read back: the mirror's evidence shape, less the id, plus when it was taken. */
export type CreditNoteSpendReading = Omit<CreditNoteMirrorEvidence, "creditNoteId"> & { observedAt: Date };

export function storedSpendEvidenceFrom(evidence: CreditNoteMirrorEvidence, observedAt: Date): StoredCreditNoteSpendEvidence {
  return {
    status: evidence.status,
    totalCents: evidence.totalCents,
    remainingCents: evidence.remainingCents,
    allocations: evidence.allocations.map(({ invoiceId, cents }) => ({ invoiceId, cents })),
    payments: evidence.payments.map(({ paymentId, cents }) => ({ paymentId, cents })),
    noteUpdatedAt: evidence.updatedAt?.toISOString() ?? null,
    observedAt: observedAt.toISOString(),
  };
}

const isCents = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isNullableCents = (value: unknown): value is number | null => value === null || isCents(value);
const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const readInstant = (value: unknown): Date | null | undefined => {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

function readEntries<K extends "invoiceId" | "paymentId">(value: unknown, key: K): Array<Record<K, string> & { cents: number }> | null {
  if (!Array.isArray(value)) return null;
  const entries: Array<Record<K, string> & { cents: number }> = [];
  for (const raw of value) {
    const entry = asRecord(raw);
    const id = entry?.[key];
    if (!entry || typeof id !== "string" || id === "" || !isCents(entry.cents)) return null;
    entries.push({ [key]: id, cents: entry.cents } as Record<K, string> & { cents: number });
  }
  return entries;
}

/**
 * The reading out of a link's metadata, or null for anything that is not exactly
 * the shape written above (absent, hand-edited, from another build): a reading
 * that cannot be trusted raises no warning.
 */
export function readStoredSpendEvidence(metadata: unknown): CreditNoteSpendReading | null {
  const raw = asRecord(asRecord(metadata)?.[CREDIT_NOTE_SPEND_EVIDENCE_KEY]);
  if (!raw) return null;
  const { status, totalCents, remainingCents } = raw;
  if (status !== null && typeof status !== "string") return null;
  if (!isNullableCents(totalCents) || !isNullableCents(remainingCents)) return null;
  const allocations = readEntries(raw.allocations, "invoiceId");
  const payments = readEntries(raw.payments, "paymentId");
  const updatedAt = readInstant(raw.noteUpdatedAt);
  const observedAt = readInstant(raw.observedAt);
  if (!allocations || !payments || updatedAt === undefined || !observedAt) return null;
  return { status, totalCents, remainingCents, allocations, payments, updatedAt, observedAt };
}

/**
 * The metadata to merge onto the note's links at ingest: the reading, when the note
 * funds a member's credit lot (most notes fund none: one indexed read, then an empty
 * object). Built from the note the reconcile already holds; it makes no Xero call.
 */
export async function creditNoteSpendEvidenceMetadata(
  note: XeroCreditNoteLike,
  db: Pick<Prisma.TransactionClient, "memberCredit">,
  observedAt: Date = new Date(),
): Promise<Record<string, StoredCreditNoteSpendEvidence>> {
  const evidence = creditNoteMirrorEvidenceFrom(note);
  if (!evidence) return {};
  const funded = await db.memberCredit.findFirst({
    where: { xeroCreditNoteId: evidence.creditNoteId, amountCents: { gt: 0 }, ...NOT_A_CONVERGENCE_ROW },
    select: { id: true },
  });
  return funded ? { [CREDIT_NOTE_SPEND_EVIDENCE_KEY]: storedSpendEvidenceFrom(evidence, observedAt) } : {};
}

/** A link the reconcile writes, with the reading merged in; a refund note's link is left as it is. */
export function withCreditNoteSpendEvidence(
  link: XeroObjectLinkInput,
  spendEvidence: Record<string, StoredCreditNoteSpendEvidence>,
): XeroObjectLinkInput {
  if (!(CREDIT_NOTE_SPEND_EVIDENCE_KEY in spendEvidence)) return link;
  if (REFUND_NOTE_LINK_ROLES.some((role) => isRefundNoteLinkOf(link, role))) return link;
  return { ...link, metadata: { ...asRecord(link.metadata), ...spendEvidence } };
}
