import "server-only";

/**
 * A BANK-TRANSFER BOOKING'S CHARGE BEFORE SETTLEMENT, FROM THE LEGACY SIDE
 * (#4628, Ledger M3c; the M3 plan on #4515). Inside the door's transaction,
 * under the `lock(1)` (and lodge key) it already holds.
 *
 * The legacy ledger posts a booking's charge lines only at confirmation
 * (`INV-MONEY-032`/`033`), but an internet-banking booking is issued a payable
 * invoice before any money arrives. So at the binding moment the door posts
 * the member-money journal's R01 from the lines its confirmation WOULD post for
 * the booking as it stands (`planConfirmationPostings`, the one plan the
 * confirmation itself writes), and an edit or cancellation before settlement
 * re-states that charge through the same planners: the confirmation planner
 * over the stored rows after the edit, and the cancellation planner over those
 * planned lines. Nothing is written to the legacy ledger here.
 *
 * Everything posts through `postPendingBookingJournal`, which posts nothing
 * for a booking never bound (a draft, a quote, a card booking, a waitlist
 * entry: not a sale) or one already confirmed on the legacy ledger. When that
 * confirmation comes, its lines link to the charge already posted
 * (`postBookingLedgerJournal`'s bridge), so nothing is charged twice.
 */
import type { Prisma } from "@prisma/client";

import { planCancellationChargeLines } from "@/lib/booking-ledger-cancellation-posting";
import type { ReversibleChargeLine } from "@/lib/booking-ledger-charge-line";
import { planConfirmationPostings, readConfirmationBooking } from "@/lib/booking-ledger-confirmation-sync";
import { ledgerLineAmountCents, type BookingLedgerPosting } from "@/lib/booking-ledger-write";
import logger from "@/lib/logger";
import { postPendingBookingJournal, type BookingJournalContext, type StandingChargeLine } from "@/lib/member-money/doors";

type Tx = Prisma.TransactionClient;

/** A planned line as the journal maps it. A planned reversal names its target by posting key, which is also its id here. */
function standing(posting: BookingLedgerPosting): StandingChargeLine {
  const reversesLineId = posting.reversesLineId ?? null;
  return {
    kind: posting.kind,
    amountCents: ledgerLineAmountCents(posting),
    postingKey: posting.postingKey,
    reversesLineId,
    reversedPostingKey: reversesLineId,
  };
}

const REVERSIBLE_KINDS = new Set<BookingLedgerPosting["kind"]>(["GUEST_NIGHT", "PROMOTION", "CHANGE_FEE"]);

/** A planned confirmation line as the cancellation planner reads a posted one: its posting key is its id. */
function asPostedLine(posting: BookingLedgerPosting): ReversibleChargeLine {
  return {
    id: posting.postingKey,
    kind: posting.kind as ReversibleChargeLine["kind"],
    sign: posting.sign,
    quantity: posting.quantity,
    unitCents: posting.unitCents,
    bookingGuestId: posting.bookingGuestId ?? null,
    nightStart: posting.nightStart ?? null,
    nightEndExclusive: posting.nightEndExclusive ?? null,
    rateMembershipTypeId: posting.rateMembershipTypeId ?? null,
    ageTier: posting.ageTier ?? null,
    guestNames: [...(posting.guestNames ?? [])],
    narration: posting.narration,
    reversesLineId: null,
  };
}

/** The lines the booking's confirmation would post now, read and planned in the door's transaction. */
async function standingConfirmation(tx: Tx, bookingId: string): Promise<BookingLedgerPosting[]> {
  return planConfirmationPostings(tx, await readConfirmationBooking(tx, bookingId), "pending charge");
}

/**
 * R01 at the binding moment: internet-banking create, switch to internet
 * banking, school pay-on-account. After the door's booking, guest, night and
 * payment writes, so the plan reads what the invoice bills.
 */
export async function postBindingCharge(tx: Tx, journal: BookingJournalContext, bookingId: string, lodgeId: string): Promise<void> {
  await postPendingBookingJournal(tx, journal, {
    bookingId,
    lodgeId,
    event: { kind: "binding" },
    standing: async () => (await standingConfirmation(tx, bookingId)).map(standing),
  });
}

/** R02 before settlement: an edit's modification, after the edit's own writes. */
export async function postPendingModificationCharge(
  tx: Tx,
  journal: BookingJournalContext,
  input: { bookingId: string; lodgeId: string; modificationId: string },
): Promise<void> {
  await postPendingBookingJournal(tx, journal, {
    bookingId: input.bookingId,
    lodgeId: input.lodgeId,
    event: { kind: "modification", modificationId: input.modificationId },
    standing: async () => (await standingConfirmation(tx, input.bookingId)).map(standing),
  });
}

/**
 * R04 before settlement: what the cancellation planner leaves of the planned
 * confirmation, given what the club keeps (`keptCents`, as the cancel path
 * passes the legacy poster).
 */
export async function postPendingCancellationCharge(
  tx: Tx,
  journal: BookingJournalContext,
  input: { bookingId: string; lodgeId: string; keptCents: number; policyKeptCents?: number; site: string },
): Promise<void> {
  await postPendingBookingJournal(tx, journal, {
    bookingId: input.bookingId,
    lodgeId: input.lodgeId,
    event: { kind: "cancellation" },
    standing: async () => {
      const confirmation = await standingConfirmation(tx, input.bookingId);
      const plan = planCancellationChargeLines({
        bookingId: input.bookingId,
        lodgeId: input.lodgeId,
        keptCents: input.keptCents,
        ...(input.policyKeptCents === undefined ? {} : { policyKeptCents: input.policyKeptCents }),
        chargeLines: confirmation.filter((posting) => REVERSIBLE_KINDS.has(posting.kind)).map(asPostedLine),
        adjustmentLines: [],
      });
      if (plan.kind === "lines") return [...confirmation, ...plan.postings].map(standing);
      // The legacy poster's own refusal (a kept figure that is not whole cents): logged and
      // skipped as it skips, so the census reports the pending charge the cancel left.
      logger.warn(
        { bookingId: input.bookingId, site: input.site, reason: plan.reason, keptCents: input.keptCents },
        "Member-money journal: a pending charge's cancellation was not posted; the cancellation stands (#4628)",
      );
      return null;
    },
  });
}
