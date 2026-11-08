import type { Prisma } from "@prisma/client";
import { ORGANISER_SHARE_RECEIPT_REASON } from "../../organiser-extra-state";
import { isCapturedTransactionStatus } from "../../payment-transaction-status";
import { memberMoneyApplicationTotals, type ApplicationState, type ApplicationTotals } from "./application-state";
import { memberMoneyEventKeys } from "./keys";
import { readMemberMoneyApplicationState } from "./application-read";
import { bookingOwnerDebtor, readBookingLiveChargeCents } from "./booking-journal-read";
import { CAPTURE_CASH_ACCOUNTS, CAPTURE_KINDS } from "../../booking-ledger-capture-kinds";
import { bookingReceiptEventKey, bookingReceiptRow, readMergedDebtorBalances } from "./booking-receipts";

export type ReceiptCensusClass = "UNBRIDGED_SETTLEMENT_LINE" | "RECEIPT_WITHOUT_EVENT" | "RECEIPT_AMOUNT_DRIFT"
  | "OVER_COLLECTED" | "UNAPPLIED_RECEIPT_ON_OPEN_CHARGE" | "MERGED_DEBTOR_BALANCE" | "COLLECTION_ON_REVERSED_RECEIPT";
export interface ReceiptCensusFinding { bookingId: string; identity: string; kind: ReceiptCensusClass; cents: number }

type Db = Prisma.TransactionClient;

/** Population is exactly R01, including archived bookings. No provider lookup, lock or repair. */
export async function receiptPopulationPaymentIds(tx: Db): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const events = await tx.memberMoneyEvent.findMany({ where: { sourceKind: "BOOKING", eventKey: { startsWith: "booking-charge:" } },
      orderBy: { id: "asc" }, take: 500, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), select: { id: true, sourceIdentity: true } });
    if (events.length === 0) break;
    const payments = await tx.payment.findMany({ where: { bookingId: { in: events.map((e) => e.sourceIdentity) } }, select: { id: true }, orderBy: { id: "asc" } });
    ids.push(...payments.map((p) => p.id));
    cursor = events.at(-1)!.id;
  }
  return ids;
}

/**
 * The receipts' cash no collection has applied. A receipt a merge carried to the owner is collected through a
 * stand-in (a residue move's or a merge-follow credit), so each receipt's own credit and every credit its one
 * collection applied are one source cap: what any of them collected counts against that receipt alone. A reversed
 * receipt counts nothing, and its reversal reverses that collection too; one whose capped set still applies cash is
 * returned in `orphaned`, by receipt event key, so a writer that skips that step cannot hide.
 */
async function receiptApplication(tx: Db, rows: readonly { id: string; stripePaymentIntentId: string | null; reason: string | null }[],
  lines: readonly { id: string; kind: string; anchorId: string | null; reversesLineId: string | null; amountCents: number }[],
  state: ApplicationState, totals: ApplicationTotals): Promise<{ unapplied: number; orphaned: [string, number][] }> {
  const keys = [...new Set(lines.flatMap((line) => {
    const row = bookingReceiptRow(line, rows);
    return row ? [bookingReceiptEventKey(row, line)] : [];
  }))];
  const events = await tx.memberMoneyEvent.findMany({ where: { eventKey: { in: [...keys, ...keys.map(memberMoneyEventKeys.collect)] } },
    select: { eventKey: true, journal: { select: { lines: { where: { account: "MEMBER_RECEIVABLE", side: "CREDIT" }, select: { id: true } },
      applications: { select: { sourceLineId: true } } } } } });
  const byKey = new Map(events.map((event) => [event.eventKey, event.journal]));
  let unapplied = 0;
  const orphaned: [string, number][] = [];
  for (const key of keys) {
    const own = state.sources.find((s) => s.id === byKey.get(key)?.lines[0]?.id);
    if (!own) continue;
    const capped = new Set([own.id, ...(byKey.get(memberMoneyEventKeys.collect(key))?.applications.map((a) => a.sourceLineId) ?? [])]);
    const applied = [...capped].reduce((n, id) => n + (totals.sources.get(id) ?? 0), 0);
    if (own.reversed) { if (applied > 0) orphaned.push([key, applied]); continue; }
    unapplied += Math.max(0, own.amountCents - applied);
  }
  return { unapplied, orphaned };
}

/** One population booking in the caller's repeatable-read, read-only snapshot. */
export async function readBookingReceiptCensus(tx: Db, paymentId: string): Promise<ReceiptCensusFinding[]> {
  const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { booking: true, transactions: true } });
  const bookingId = payment.bookingId;
  const findings: ReceiptCensusFinding[] = [];
  const add = (kind: ReceiptCensusClass, identity: string, cents: number) => findings.push({ kind, identity, bookingId, cents });
  const lines = await tx.bookingLedgerLine.findMany({ where: { bookingId, side: "SETTLEMENT", kind: { in: [...CAPTURE_KINDS] } } });
  for (const row of payment.transactions.filter((r) => r.reason !== ORGANISER_SHARE_RECEIPT_REASON && isCapturedTransactionStatus(r.status) && r.amountCents > 0)) {
    const line = lines.find((l) => l.anchorId === row.id && l.reversesLineId === null && !lines.some((r) => r.reversesLineId === l.id));
    if (!line) { add("UNBRIDGED_SETTLEMENT_LINE", row.id, row.amountCents); add("RECEIPT_WITHOUT_EVENT", row.id, row.amountCents); continue; }
    const eventKey = bookingReceiptEventKey(row, line);
    const event = await tx.memberMoneyEvent.findUnique({ where: { eventKey }, select: { journal: { select: { lines: { select: { account: true, side: true, amountCents: true } } } } } });
    if (!event) add("RECEIPT_WITHOUT_EVENT", row.id, row.amountCents);
    else {
      const posted = event.journal!.lines.filter((l) => l.side === "DEBIT" && CAPTURE_CASH_ACCOUNTS.includes(l.account)).reduce((n, l) => n + l.amountCents, 0);
      if (posted !== row.amountCents) add("RECEIPT_AMOUNT_DRIFT", row.id, row.amountCents - posted);
    }
    if (!await tx.memberMoneySourceLink.findUnique({ where: { bookingLedgerLineId: line.id }, select: { id: true } })) add("UNBRIDGED_SETTLEMENT_LINE", line.id, line.amountCents);
  }
  const state = await readMemberMoneyApplicationState(tx, bookingId);
  const totals = memberMoneyApplicationTotals(state);
  const charge = await readBookingLiveChargeCents(tx, bookingId);
  if (totals.collected > charge) add("OVER_COLLECTED", bookingId, totals.collected - charge);
  const { unapplied, orphaned } = await receiptApplication(tx, payment.transactions, lines, state, totals);
  for (const [key, cents] of orphaned) add("COLLECTION_ON_REVERSED_RECEIPT", key, cents);
  if (unapplied > 0 && charge > totals.collected) add("UNAPPLIED_RECEIPT_ON_OPEN_CHARGE", bookingId, Math.min(unapplied, charge - totals.collected));
  const owner = bookingOwnerDebtor(payment.booking);
  const balances = await readMergedDebtorBalances(tx, bookingId, owner.kind === "MEMBER" ? owner.memberId : null);
  for (const [memberId, cents] of balances) if (cents !== 0) add("MERGED_DEBTOR_BALANCE", memberId, cents);
  return findings;
}
