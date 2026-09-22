import "server-only";

/**
 * THE ONLY DOOR INTO `BookingLedgerLine` (#3580, programme #3527).
 *
 * The ledger is append-only: a line is never updated and never deleted, and a
 * correction is a new line that names the one it reverses. That rule is worth
 * nothing if any module can reach `prisma.bookingLedgerLine.update`, so this
 * module is the one home for writing the table and it exposes creation alone.
 * `booking-ledger-append-only-census.test.ts` reads the tree and fails on a
 * write to the delegate from anywhere else, the way the stored-night-price
 * repair census guards its own single writer.
 *
 * Every posting takes a transaction client, never the singleton. A line
 * records something that happened, so it is written inside the transaction
 * that made it happen: a settle that rolls back must not leave a line behind
 * saying it did not.
 *
 * C1 posts charge lines at confirmation. Nothing reads them (`INV-PAY-047`'s
 * mirror is still the answer until C5, #3584).
 */
import type { AgeTier, Prisma } from "@prisma/client";

/** The subset of a transaction client this module needs. */
export type BookingLedgerWriteStore = Pick<Prisma.TransactionClient, "bookingLedgerLine">;

/**
 * One line to post. `amountCents` is deliberately ABSENT: it is
 * `sign * unitCents * quantity` and this module computes it, so no caller can
 * hand over a figure that disagrees with its own parts. The database checks
 * the same arithmetic, which is the second fence (#3580's migration).
 */
export type BookingLedgerPosting = {
  bookingId: string;
  lodgeId: string;
  side: "CHARGE" | "SETTLEMENT" | "ADJUSTMENT";
  kind:
    | "GUEST_NIGHT"
    | "CHANGE_FEE"
    | "PROMOTION"
    | "GROUP_DISCOUNT"
    | "CARD_CAPTURE"
    | "BANK_RECEIPT"
    | "CREDIT_APPLIED"
    | "CASH_RECORDED"
    | "CARD_REFUND"
    | "BANK_REFUND"
    | "CREDIT_ISSUED"
    | "AGREED_ADJUSTMENT";
  sign: 1 | -1;
  /** Guest-nights for a `GUEST_NIGHT` line; 1 for everything else. */
  quantity: number;
  /** The price of one unit, in whole non-negative cents. */
  unitCents: number;
  anchorKind:
    | "CONFIRMATION"
    | "MODIFICATION"
    | "REVIEW_TASK"
    | "PAYMENT_TRANSACTION"
    | "PAYMENT_REFUND"
    | "MEMBER_CREDIT"
    | "CANCELLATION";
  anchorId: string;
  narration: string;
  bookingGuestId?: string | null;
  nightStart?: Date | null;
  nightEndExclusive?: Date | null;
  rateMembershipTypeId?: string | null;
  ageTier?: AgeTier | null;
  guestNames?: readonly string[];
  settlementMethod?: "CARD" | "INTERNET_BANKING" | "ACCOUNT_CREDIT" | "CASH" | null;
  reversesLineId?: string | null;
  postedByMemberId?: string | null;
};

export class BookingLedgerPostingError extends Error {
  constructor(message: string) {
    super(`INV-MONEY-032: ${message}`);
    this.name = "BookingLedgerPostingError";
  }
}

/**
 * The shape rules, refused here as well as in the database.
 *
 * The database constraints are the ones that cannot be bypassed; these exist
 * so a caller gets a sentence naming what it did wrong rather than a Postgres
 * constraint name, and so a unit test can prove the refusal without a
 * database. They say the same thing, deliberately — if they ever disagree,
 * the database is right.
 */
function assertPostable(posting: BookingLedgerPosting): void {
  if (!Number.isSafeInteger(posting.unitCents) || posting.unitCents < 0) {
    throw new BookingLedgerPostingError(
      `unitCents must be a whole number of cents, not negative — the direction is the sign (got ${posting.unitCents})`,
    );
  }
  if (!Number.isSafeInteger(posting.quantity) || posting.quantity < 0) {
    throw new BookingLedgerPostingError(
      `quantity must be a whole non-negative number (got ${posting.quantity})`,
    );
  }
  const namesStrand =
    posting.bookingGuestId != null &&
    posting.nightStart != null &&
    posting.nightEndExclusive != null;
  const namesAnyStrandField =
    posting.bookingGuestId != null ||
    posting.nightStart != null ||
    posting.nightEndExclusive != null;
  if (posting.kind === "GUEST_NIGHT" && !namesStrand) {
    throw new BookingLedgerPostingError(
      "a GUEST_NIGHT line must name the strand and the nights it prices",
    );
  }
  // Two checks rather than one equality: a line carrying a strand id and no
  // night fields satisfied the equality while still claiming a strand it has
  // no business naming (review of #3580). The database holds the same pair.
  if (posting.kind !== "GUEST_NIGHT" && namesAnyStrandField) {
    throw new BookingLedgerPostingError(
      `a ${posting.kind} line prices no strand, so it names no guest and no nights`,
    );
  }
  if ((posting.side === "SETTLEMENT") !== (posting.settlementMethod != null)) {
    throw new BookingLedgerPostingError(
      posting.side === "SETTLEMENT"
        ? "a SETTLEMENT line must say how the money moved"
        : `a ${posting.side} line moves no money, so it names no settlement method`,
    );
  }
}

/** `sign * unitCents * quantity` — the one place a line's figure is computed. */
export function ledgerLineAmountCents(
  posting: Pick<BookingLedgerPosting, "sign" | "unitCents" | "quantity">,
): number {
  return posting.sign * posting.unitCents * posting.quantity;
}

function toCreateInput(posting: BookingLedgerPosting): Prisma.BookingLedgerLineCreateManyInput {
  assertPostable(posting);
  return {
    bookingId: posting.bookingId,
    lodgeId: posting.lodgeId,
    side: posting.side,
    kind: posting.kind,
    sign: posting.sign,
    quantity: posting.quantity,
    unitCents: posting.unitCents,
    amountCents: ledgerLineAmountCents(posting),
    anchorKind: posting.anchorKind,
    anchorId: posting.anchorId,
    narration: posting.narration,
    bookingGuestId: posting.bookingGuestId ?? null,
    nightStart: posting.nightStart ?? null,
    nightEndExclusive: posting.nightEndExclusive ?? null,
    rateMembershipTypeId: posting.rateMembershipTypeId ?? null,
    ageTier: posting.ageTier ?? null,
    guestNames: [...(posting.guestNames ?? [])],
    settlementMethod: posting.settlementMethod ?? null,
    reversesLineId: posting.reversesLineId ?? null,
    postedByMemberId: posting.postedByMemberId ?? null,
  };
}

/**
 * Validate and build the rows, touching no database.
 *
 * SEPARATE FROM THE WRITE ON PURPOSE. A caller inside a transaction that must
 * survive a bad plan can call this first: a `BookingLedgerPostingError` thrown
 * here is an ordinary JavaScript throw, so the transaction is untouched and
 * the caller may carry on. Once a statement has reached Postgres and been
 * refused, the transaction is aborted (`25P02`) and no `catch` in JavaScript
 * can bring it back — which is why the write below is never the thing a
 * caller is invited to swallow.
 */
export function buildBookingLedgerRows(
  postings: readonly BookingLedgerPosting[],
): Prisma.BookingLedgerLineCreateManyInput[] {
  return postings.map(toCreateInput);
}

/** Write already-built rows. One statement, inside the caller's transaction. */
export async function writeBookingLedgerRows(
  store: BookingLedgerWriteStore,
  rows: readonly Prisma.BookingLedgerLineCreateManyInput[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const result = await store.bookingLedgerLine.createMany({ data: [...rows] });
  return result.count;
}

/**
 * Validate, build and write, inside the caller's transaction.
 *
 * Returns the number written. A partial write is impossible: `createMany` is
 * one statement and the caller's transaction is the boundary.
 */
export async function postBookingLedgerLines(
  store: BookingLedgerWriteStore,
  postings: readonly BookingLedgerPosting[],
): Promise<number> {
  return writeBookingLedgerRows(store, buildBookingLedgerRows(postings));
}
