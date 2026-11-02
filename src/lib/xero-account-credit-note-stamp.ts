/**
 * The account-credit note's back-link onto the member's credit
 * (`MemberCredit.xeroCreditNoteId`), which `INV-PAY-023`'s allocation engine
 * reads as "this lot is that note". Written by `createUnappliedXeroCreditNote`
 * once Xero has made the note, or found it already linked.
 *
 * #4685: a note stamps ONE credit, the one it was raised for. The stamp used to
 * be an `updateMany` over member, booking, amount and description, so two
 * credits agreeing on all four both took the first note and the second note was
 * recorded against no credit. Now the queued row names its credit
 * (`memberCreditId`) and the stamp writes that row by id. A row the previous
 * release queued names none, so it falls back to the old match, one row at a
 * time, oldest first (`docs/BLUE_GREEN_MIGRATION_POLICY.md`).
 *
 * Every stamp keeps the `xeroCreditNoteId: null` guard: it never overwrites a
 * credit's note. And a note already on one of the booking's cancellation
 * credits never stamps a second (a replay of a created note finds it there),
 * re-read before each write. Two writers stamping the same note on two
 * different credits at the same instant can still both land: nothing locks the
 * pair (`INV-INT-036`'s limit).
 *
 * #4705: the inbound credit-note reconcile stamps through here too. It has the
 * note but not the row, so it reads the credit off the note's own outbox row
 * (`accountCreditNoteRaisedFor`), else takes the fallback.
 *
 * Locking (`INV-LOCK-001`): none added. The stamp changes no balance, booking
 * status or settlement money - only the link - and each write is one
 * null-guarded single-row update, so a lost race writes nothing; no key, no
 * order (`INV-LOCK-002`), no new site (`INV-LOCK-003`).
 */
import { CreditType } from "@prisma/client";
import { cancellationCreditDescription } from "@/lib/cancellation-settled-money";
import { internetBankingLateCashCreditDescription } from "@/lib/internet-banking-late-cash-credit";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { asRecord } from "@/lib/xero-json";
import { readAccountCreditNoteCredit } from "@/lib/xero-operation-outbox-payload";

/** The descriptions the account-credit pipeline's cancellation credits carry. */
function stampableCancellationDescriptions(bookingId: string): string[] {
  // The cancellation-flow description plus the Internet Banking pipeline's two
  // (late capacity failure, and a payment landing on an already-cancelled
  // booking, #1357), each from its writers' own builder.
  return [
    cancellationCreditDescription(bookingId),
    internetBankingLateCashCreditDescription(bookingId, { bookingCancelled: false }),
    internetBankingLateCashCreditDescription(bookingId, { bookingCancelled: true }),
  ];
}

/**
 * Stamp `creditNoteId` onto the cancellation credit it was raised for. Returns
 * the credit stamped, or null when none was (already stamped, another credit
 * holds the note, or no credit matches).
 */
export async function stampCancellationCreditXeroNote(params: {
  memberId: string;
  bookingId: string;
  refundAmountCents: number;
  creditNoteId: string;
  /** The credit the note was raised for; absent on rows queued before #4685. */
  memberCreditId?: string;
}): Promise<string | null> {
  const owned = {
    memberId: params.memberId,
    sourceBookingId: params.bookingId,
    type: CreditType.CANCELLATION_REFUND,
  };
  // A note already on one of the booking's cancellation credits stamps no
  // other. Read before every write, so a fallback pass that lost its candidate
  // to this same note (a concurrent retry, the inbound handler) stops there.
  const noteHeld = async () =>
    (await prisma.memberCredit.findFirst({ where: { ...owned, xeroCreditNoteId: params.creditNoteId }, select: { id: true } })) !== null;

  if (params.memberCreditId) {
    if (await noteHeld()) return null;
    const stamped = await prisma.memberCredit.updateMany({
      where: {
        id: params.memberCreditId,
        ...owned,
        amountCents: params.refundAmountCents,
        xeroCreditNoteId: null,
      },
      data: { xeroCreditNoteId: params.creditNoteId },
    });
    if (stamped.count === 1) return params.memberCreditId;
    logger.warn(
      { memberCreditId: params.memberCreditId, creditNoteId: params.creditNoteId, bookingId: params.bookingId },
      "Xero account-credit note not stamped on its credit: the credit already names a note, or no longer matches it (#4685)"
    );
    return null;
  }

  // A row queued before #4685: the old match, one credit at a time. A lost
  // stamp means that credit just took a note, so the next pass reads one fewer
  // candidate and the loop ends.
  for (;;) {
    if (await noteHeld()) return null;
    const candidate = await prisma.memberCredit.findFirst({
      where: {
        ...owned,
        amountCents: params.refundAmountCents,
        description: { in: stampableCancellationDescriptions(params.bookingId) },
        xeroCreditNoteId: null,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    if (!candidate) return null;
    const stamped = await prisma.memberCredit.updateMany({
      where: { id: candidate.id, xeroCreditNoteId: null },
      data: { xeroCreditNoteId: params.creditNoteId },
    });
    if (stamped.count === 1) return candidate.id;
  }
}

/**
 * #4705: the credit an account-credit note was raised for, as the note's own
 * outbox row named it (`memberCreditId`, kept on the queued and executed
 * shapes), and the payments whose rows named it. Read by the inbound
 * reconcile, which reaches a note by its id. One credit named across the
 * payments' rows is returned; none, or rows that disagree, return null, and
 * the stamp falls back to its old match.
 */
export async function accountCreditNoteRaisedFor(params: {
  creditNoteId: string;
  paymentIds: string[];
}): Promise<{ memberCreditId: string; paymentIds: string[] } | null> {
  if (params.paymentIds.length === 0) return null;
  const rows = await prisma.xeroSyncOperation.findMany({
    where: {
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: { in: params.paymentIds },
      xeroObjectId: params.creditNoteId,
    },
    select: { localId: true, requestPayload: true },
  });
  const named = rows.flatMap((row) => {
    const { memberCreditId } = readAccountCreditNoteCredit(asRecord(row.requestPayload) ?? {});
    return memberCreditId && row.localId ? [{ memberCreditId, paymentId: row.localId }] : [];
  });
  const credits = new Set(named.map((row) => row.memberCreditId));
  const [memberCreditId] = credits;
  if (credits.size !== 1 || !memberCreditId) return null;
  return { memberCreditId, paymentIds: [...new Set(named.map((row) => row.paymentId))] };
}

/**
 * #4705 (PR #4711 review): whether any credit lot, of any type, or any applied
 * slice already records the note. The inbound reconcile stamps only a note
 * nothing holds: a held note is either already on its credit, or an
 * applied-credit note whose holder is a lot this stamp never sees (an
 * admin-adjustment remainder), and stamping it on a cancellation credit too
 * would give one note two holders.
 */
export async function accountCreditNoteHeld(creditNoteId: string): Promise<boolean> {
  const [lot, slice] = await Promise.all([
    prisma.memberCredit.findFirst({ where: { xeroCreditNoteId: creditNoteId }, select: { id: true } }),
    prisma.memberCreditNoteAllocation.findFirst({ where: { xeroCreditNoteId: creditNoteId }, select: { id: true } }),
  ]);
  return lot !== null || slice !== null;
}

/**
 * Stamp a modification's account-credit note onto the edit's credit. Already
 * one row: `sourceBookingModificationId` is unique, so at most one credit names
 * the edit.
 */
export async function stampBookingModificationCreditXeroNote(params: {
  memberId: string;
  bookingId: string;
  bookingModificationId: string;
  refundAmountCents: number;
  creditNoteId: string;
}): Promise<void> {
  await prisma.memberCredit.updateMany({
    where: {
      memberId: params.memberId,
      sourceBookingId: params.bookingId,
      sourceBookingModificationId: params.bookingModificationId,
      amountCents: params.refundAmountCents,
      type: CreditType.BOOKING_MODIFICATION_REFUND,
      xeroCreditNoteId: null,
    },
    data: {
      xeroCreditNoteId: params.creditNoteId,
    },
  });
}
