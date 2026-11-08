import type { Prisma } from "@prisma/client";
import { ORGANISER_SHARE_RECEIPT_REASON } from "../../organiser-extra-state";
import { isCapturedTransactionStatus } from "../../payment-transaction-status";
import { memberMoneyApplicationTotals } from "./application-state";
import { readMemberMoneyApplicationState } from "./application-read";
import { bookingOwnerDebtor, readBookingLiveChargeCents } from "./booking-journal-read";
import { CAPTURE_CASH_ACCOUNTS, CAPTURE_KINDS } from "../../booking-ledger-capture-kinds";
import { bookingReceiptEventKey, readMergedDebtorBalances } from "./booking-receipts";

export type ReceiptCensusClass = "UNBRIDGED_SETTLEMENT_LINE" | "RECEIPT_WITHOUT_EVENT" | "RECEIPT_AMOUNT_DRIFT"
  | "OVER_COLLECTED" | "UNAPPLIED_RECEIPT_ON_OPEN_CHARGE" | "MERGED_DEBTOR_BALANCE";
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
  const credits = state.sources.filter((s) => !s.reversed && s.account === "MEMBER_RECEIVABLE" && s.side === "CREDIT");
  // A receipt a merge carried to the owner is applied through its stand-in (a residue or merge-follow credit), so
  // what those collected counts against the receipts' unapplied cash.
  const carried = credits.filter((s) => s.sourceKind !== "PAYMENT").reduce((n, s) => n + (totals.sources.get(s.id) ?? 0), 0);
  const unapplied = Math.max(0, credits.filter((s) => s.sourceKind === "PAYMENT")
    .reduce((n, s) => n + Math.max(0, s.amountCents - (totals.sources.get(s.id) ?? 0)), 0) - carried);
  if (unapplied > 0 && charge > totals.collected) add("UNAPPLIED_RECEIPT_ON_OPEN_CHARGE", bookingId, Math.min(unapplied, charge - totals.collected));
  const owner = bookingOwnerDebtor(payment.booking);
  const balances = await readMergedDebtorBalances(tx, bookingId, owner.kind === "MEMBER" ? owner.memberId : null);
  for (const [memberId, cents] of balances) if (cents !== 0) add("MERGED_DEBTOR_BALANCE", memberId, cents);
  return findings;
}
