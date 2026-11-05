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
 * can never leave old allocations beside a newer total. A reading older than the
 * one already kept (by Xero's change time) is not written over it. A refund note's
 * links never carry it (a refund note funds no lot, and its snapshot has its own
 * write order, `judgeRefundNoteWrite`). A note that funds a lot but has no active
 * credit-note link gets no reading, so it is never warned about. Nothing here reads
 * or writes Xero or the credit ledger.
 */
import type { Prisma } from "@prisma/client";
import { isNonNegativeIntegerCents } from "@/lib/edit-financial-review-context";
import { fundingLotWhere } from "@/lib/xero-applied-credit-slice-lookup";
import {
  creditNoteMirrorEvidenceFrom,
  readCreditNoteInstant,
  type CreditNoteMirrorEvidence,
  type XeroCreditNoteLike,
} from "@/lib/xero-credit-note-mirror";
import { asRecord } from "@/lib/xero-json";
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

const isNullableCents = (value: unknown): value is number | null => value === null || isNonNegativeIntegerCents(value);

function readEntries<K extends "invoiceId" | "paymentId">(value: unknown, key: K): Array<Record<K, string> & { cents: number }> | null {
  if (!Array.isArray(value)) return null;
  const entries: Array<Record<K, string> & { cents: number }> = [];
  for (const raw of value) {
    const entry = asRecord(raw);
    const id = entry?.[key];
    if (!entry || typeof id !== "string" || id === "" || !isNonNegativeIntegerCents(entry.cents)) return null;
    entries.push({ [key]: id, cents: entry.cents } as Record<K, string> & { cents: number });
  }
  return entries;
}

/** A stored ISO instant: a string Xero's reader accepts, else `undefined` (untrusted). */
const readStoredInstant = (value: unknown): Date | undefined =>
  typeof value === "string" ? readCreditNoteInstant(value) ?? undefined : undefined;

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
  const updatedAt = raw.noteUpdatedAt === null ? null : readStoredInstant(raw.noteUpdatedAt);
  const observedAt = readStoredInstant(raw.observedAt);
  if (!allocations || !payments || updatedAt === undefined || !observedAt) return null;
  return { status, totalCents, remainingCents, allocations, payments, updatedAt, observedAt };
}

/**
 * THE ORDER OF TWO READINGS OF ONE NOTE: by Xero's change time (a reading with
 * none is the oldest), then by when the app took it. Positive when `a` is newer.
 */
export function compareSpendReadings(
  a: Pick<CreditNoteSpendReading, "updatedAt" | "observedAt">,
  b: Pick<CreditNoteSpendReading, "updatedAt" | "observedAt">,
): number {
  const byChange = (a.updatedAt?.getTime() ?? -Infinity) - (b.updatedAt?.getTime() ?? -Infinity);
  if (byChange !== 0 && !Number.isNaN(byChange)) return byChange;
  return a.observedAt.getTime() - b.observedAt.getTime();
}

/** The newest trustworthy reading per note across the note's active credit-note links. */
export async function newestSpendReadings(
  db: Pick<Prisma.TransactionClient, "xeroObjectLink">,
  where: Prisma.XeroObjectLinkWhereInput,
): Promise<Map<string, CreditNoteSpendReading>> {
  const links = await db.xeroObjectLink.findMany({
    where: { ...where, xeroObjectType: "CREDIT_NOTE", active: true },
    select: { xeroObjectId: true, metadata: true },
  });
  const readings = new Map<string, CreditNoteSpendReading>();
  for (const link of links) {
    const reading = readStoredSpendEvidence(link.metadata);
    const kept = readings.get(link.xeroObjectId);
    if (reading && (!kept || compareSpendReadings(reading, kept) > 0)) readings.set(link.xeroObjectId, reading);
  }
  return readings;
}

/**
 * The metadata to merge onto the note's links at ingest: the reading, when the note
 * funds a member's credit lot (most notes fund none: one indexed read, then an empty
 * object), and unless a reading of a later change of the note is already kept (an
 * event processed out of order must not put an older reading back). Built from the
 * note the reconcile already holds; it makes no Xero call. The kept reading is read
 * and then written without a lock: the reading is advisory, and the next event of
 * the note settles a race.
 */
export async function creditNoteSpendEvidenceMetadata(
  note: XeroCreditNoteLike,
  db: Pick<Prisma.TransactionClient, "memberCredit" | "xeroObjectLink">,
  observedAt: Date = new Date(),
): Promise<Record<string, StoredCreditNoteSpendEvidence>> {
  const evidence = creditNoteMirrorEvidenceFrom(note);
  if (!evidence) return {};
  const funded = await db.memberCredit.findFirst({ where: fundingLotWhere(evidence.creditNoteId), select: { id: true } });
  if (!funded) return {};
  const kept = (await newestSpendReadings(db, { xeroObjectId: evidence.creditNoteId })).get(evidence.creditNoteId);
  if (kept && compareSpendReadings(kept, { updatedAt: evidence.updatedAt, observedAt }) > 0) return {};
  return { [CREDIT_NOTE_SPEND_EVIDENCE_KEY]: storedSpendEvidenceFrom(evidence, observedAt) };
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
