/**
 * The public pay page's read model: what a `/pay/[token]` visitor is told and
 * what the link can still do. Extracted from `payment-link.ts` by
 * responsibility (#2956). Read-only apart from burning the link once the
 * booking is paid; token resolution stays in `payment-link.ts`, and the
 * wording comes from `booking-narrative.ts`, which this module only feeds.
 */
import { BookingStatus } from "@prisma/client";
import { buildInternetBankingPaymentReference } from "@/lib/booking-payment-methods";
import {
  resolveBookingNarrative,
  type BookingNarrative,
  type BookingNarrativeState,
  type NarrativeEvent,
  type ResolveBookingNarrativeInput,
} from "@/lib/booking-narrative";
import { bindClubTime } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import logger from "@/lib/logger";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { isPaidLikeStatus, loadPaymentLinkRecord } from "@/lib/payment-link";
import { prisma } from "@/lib/prisma";

/** The data the public page needs to actually take a payment. */
interface PaymentLinkPayable {
  checkIn: string;
  checkOut: string;
  guestCount: number;
  status: BookingStatus;
  amountCents: number;
  /**
   * The bank-transfer reference, present only when the optional Internet
   * Banking module is on. Omitted when the module is off so the public pay
   * page never offers a payment method the club hasn't enabled.
   */
  internetBankingReference?: string;
  /**
   * The link's hard expiry, ISO. The END OF THE CHECK-IN DAY in the club's
   * PERSISTED timezone (`payment-link-expiry.ts`, `INV-CONFIG-002`) — not the
   * container's, and not spelled as an abbreviation, which `INV-CONFIG-002`
   * forbids and which names one country's zone in a generic product
   * (`INV-CONFIG-001`). The pay page renders this value in that same zone.
   */
  expiresAt: string;
}

export interface PaymentLinkContext {
  state: BookingNarrativeState;
  /** Rich, plain-language wording shared with the admin booking history. */
  narrative: BookingNarrative;
  firstName: string;
  /** Present only when the booking can still be paid via this link. */
  payable: PaymentLinkPayable | null;
  /**
   * True when the page should offer the "email me a fresh link" action.
   *
   * READ THIS RATHER THAN `state === "expired_payable"` (#3194): `state` is the
   * WORDING state and this is the LINK state, and on a booking under review they
   * differ. `payable` above is the same shape of fact, read the same way.
   */
  canRequestFreshLink: boolean;
  /**
   * #3194 (epic #2797): this booking has an OPEN financial review — a saved
   * stay or guest change whose refund or charge the club is still working out.
   *
   * The pay page shows the review wording from this, composed from
   * `booking-financial-review-copy.ts` — the booking-detail banner's own home
   * for those sentences. Before this field the two pages answered one question
   * differently, and the payment link was the one that had not checked.
   */
  financialReviewPending: boolean;
  /**
   * Name of the lodge THIS booking is at (#2919), so the public pay page's
   * confirmation copy names the right property in a multi-lodge club instead of
   * falling back to the club's default lodge. Single-lodge clubs see no change.
   */
  lodgeName: string;
}

/**
 * Build the public payment page context for a raw token. Resolves the booking's
 * narrative from its durable events so guests see the same wording as admins,
 * for every state — payable, expired-but-payable, paid, bumped, cancelled,
 * declined — never a generic error. Marks the link used (idempotently) once the
 * booking is paid/completed so it cannot be replayed.
 */
export interface PaymentLinkContextReaders {
  /**
   * Whether this booking has an OPEN financial review.
   *
   * INJECTED, and required with no default (#3194). The one canonical answer
   * lives in `booking-financial-review-visibility.ts`, which carries
   * `import "server-only"` — and this module deliberately does not: it takes the
   * club's timezone through `readClubTimeZoneOutsideRequest` for exactly that
   * reason, and `cli-server-only-reach-census.test.ts` fails any operator script
   * that regains such an edge. So the read is done by the caller that is
   * unambiguously a server request — `src/app/api/pay/[token]/route.ts` — and
   * handed down, the same way `resolveBookingNarrative` takes the answer as data
   * rather than reading it.
   *
   * No default, so a second caller has to answer the question rather than
   * inherit a silent "no" about a member's money (`INV-SSOT`, "prefer
   * unrepresentable over policed").
   */
  readOpenFinancialReview: (bookingId: string) => Promise<boolean>;
}

export async function getPaymentLinkContext(
  token: string,
  { readOpenFinancialReview }: PaymentLinkContextReaders,
): Promise<PaymentLinkContext> {
  const link = await loadPaymentLinkRecord(token);
  const booking = link.booking;
  const now = new Date();

  const events = await prisma.bookingEvent.findMany({
    where: { bookingId: booking.id },
    orderBy: { occurredAt: "asc" },
    select: {
      type: true,
      occurredAt: true,
      amountCents: true,
      reason: true,
      snapshot: true,
    },
  });

  // The narrative names the day a payment, cancellation or settlement landed
  // AT THE CLUB, so it is read in the club's persisted zone rather than the
  // container's (#3123). The runtime reader, not `clubTime()`: this module is
  // reachable from `src/instrumentation.node.ts`, where `server-only` throws at
  // import. Its stay dates are @db.Date lodge nights and take no zone.
  const club = bindClubTime(await readClubTimeZoneOutsideRequest());

  const financialReviewPending = await readOpenFinancialReview(booking.id);

  const narrativeInput = {
    club,
    booking: {
      status: booking.status,
      finalPriceCents: booking.finalPriceCents,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      firstName: booking.member.firstName,
      adminReviewStatus: booking.adminReviewStatus,
      adminReviewNotes: booking.adminReviewNotes,
      adminReviewReason: booking.adminReviewReason,
    },
    events: events.map(
      (event): NarrativeEvent => ({
        type: event.type,
        occurredAt: event.occurredAt,
        amountCents: event.amountCents,
        reason: event.reason,
        snapshot: event.snapshot,
      })
    ),
    link: {
      expiresAt: link.expiresAt,
      usedAt: link.usedAt,
      revokedAt: link.revokedAt,
    },
    now,
  } satisfies ResolveBookingNarrativeInput;

  /*
    ONE PURE FUNCTION, ASKED TWO DIFFERENT QUESTIONS (#3194) — not a duplicated
    call, and the difference between the two is what keeps a reviewed booking
    payable.

    `narrative` is WHAT THE MEMBER IS TOLD. It is review-aware, so a paid booking
    under review stops saying "nothing more to do" and a payable one gains the
    review sentences alongside its amount — which is the whole of this issue.

    `paymentState` is WHAT THIS LINK CAN STILL DO, and a review changes nothing
    about that: the review is about an adjustment to a change, while the link
    collects the booking's own STORED price.

    That stored price is the PRE-CHANGE one, and saying so is the point rather
    than a caveat (#3194 fix round). Both services that can park an edit write
    `finalPriceCents` back unchanged - deliberately, so nothing settles on a
    change whose money nobody could work out - while saving the new dates and
    deleting the departing guest's row. So `payable` below is built from a
    post-edit stay and a pre-edit amount, and the note the page renders directly
    under that amount says exactly that
    (`FINANCIAL_REVIEW_AMOUNT_PREDATES_THE_CHANGE`). The link stays armed
    because the member still has to be able to pay and a hold that expires costs
    them the booking - not because the figure is final.

    Deriving `payable` from the review-aware
    state instead would have handed a CONFIRMED-unpaid member a page that says
    "pay by card or internet banking below" with nothing below it, and an
    expired-link member a page with no "email me a new link" button — they would
    then pay nothing, the hold would expire, and the booking would cancel. That
    is precisely the harm `FINANCIAL_REVIEW_NOTHING_TO_DO` is scoped to avoid,
    reintroduced one layer down.

    The second call is free of side effects and of I/O: `resolveBookingNarrative`
    reads only its input (see its file header), so asking it twice costs one
    object walk and cannot diverge from the first answer.
  */
  const narrative = resolveBookingNarrative({
    ...narrativeInput,
    financialReviewPending,
  });
  const paymentState = financialReviewPending
    ? resolveBookingNarrative(narrativeInput).state
    : narrative.state;

  // A paid/completed booking burns the link so it cannot be replayed.
  if (isPaidLikeStatus(booking.status) && !link.usedAt) {
    await prisma.paymentLink
      .update({ where: { id: link.id }, data: { usedAt: now } })
      .catch((err) =>
        logger.error({ err, paymentLinkId: link.id }, "Failed to mark payment link used")
      );
  }

  // Internet Banking is an optional module; only surface the bank-transfer
  // reference on the public pay page when the club has it enabled.
  const ibModules =
    paymentState === "payable" ? await loadEffectiveModuleFlags() : null;
  const internetBankingEnabled = Boolean(
    ibModules?.xeroIntegration && ibModules?.internetBankingPayments
  );

  const payable: PaymentLinkPayable | null =
    paymentState === "payable"
      ? {
          checkIn: booking.checkIn.toISOString(),
          checkOut: booking.checkOut.toISOString(),
          guestCount: booking.guests.length,
          status: booking.status,
          amountCents: booking.finalPriceCents,
          ...(internetBankingEnabled
            ? {
                internetBankingReference: buildInternetBankingPaymentReference(
                  booking.id
                ),
              }
            : {}),
          expiresAt: link.expiresAt.toISOString(),
        }
      : null;

  return {
    state: narrative.state,
    narrative,
    firstName: booking.member.firstName,
    payable,
    canRequestFreshLink: paymentState === "expired_payable",
    lodgeName: booking.lodge.name,
    financialReviewPending,
  };
}
