import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { hostingCoverageParticipantRetryResponse } from "@/lib/adult-member-hosting-retry-response";
import { z } from "zod";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";
import { clubFormat } from "@/lib/club-format-server";
import type { BoundClubFormat } from "@/lib/club-format-bound";
import {
  applyManualBookingPayment,
  ManualBookingPaymentError,
  MANUAL_PAYMENT_NOTE_MAX,
  type ManualBookingAdditionalOutcome,
} from "@/lib/manual-booking-payment";

const bodySchema = z
  .object({
    direction: z.enum(["paid", "unpaid"]),
    note: z.string().max(MANUAL_PAYMENT_NOTE_MAX).optional().nullable(),
    // Explicit confirmation so a manual money-state change is never a
    // single-click accident.
    confirmed: z.literal(true),
    // #2260: the admin's "email the member or not" decision. Shape-checked
    // here, contract-checked below — see the 422 branches.
    notifyMember: z.boolean().optional(),
    // The amount owing the dialog showed. NOT the settlement amount — that is
    // recomputed under the locks — but a mismatch means the price or the
    // applied credit moved, so the settle is refused rather than recorded at a
    // figure the admin never agreed to.
    expectedAmountCents: z.number().int().optional(),
    // #2397: the admin's answer to "does this cash cover the outstanding
    // extra?", sent ONLY when the dialog showed one. Absent means "the dialog
    // showed no extra" — a claim the settle re-checks under its locks, not a
    // default — so the common no-extra screen keeps its exact request shape.
    additionalCoverage: z
      .object({
        covered: z.boolean(),
        // The figure the dialog showed. Not the settled amount — that is
        // re-derived under the locks — but a mismatch means the extra moved
        // since the dialog rendered, so the settle is refused.
        expectedAdditionalAmountCents: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * The credit-election receipt appended to the admin's toast (#2265, #2262 door
 * 3). Empty for the overwhelming majority of settlements, which move no
 * election at all.
 */
function creditElectionNote(
  direction: "paid" | "unpaid",
  creditElectionCents: number | null,
  money: BoundClubFormat,
): string {
  if (creditElectionCents == null) return "";
  const amount = money.cents(creditElectionCents);
  return direction === "paid"
    ? ` This member had asked to put ${amount} of account credit towards the booking; cash cannot use it, so that credit is untouched and still on their account. They have been told.`
    : ` Their ${amount} account-credit request has been put back on the booking, so it can be used when the booking is paid again.`;
}

/**
 * #2397: the extra-owing receipt appended to the admin's toast. Empty for the
 * overwhelming majority of bookings, which carry no outstanding extra at all.
 * Both outcomes are stated plainly, because "recorded and the chase stops" and
 * "recorded and the member will still be asked for the rest" are different
 * facts and the person who just took the cash has to know which one happened.
 */
function additionalNote(
  direction: "paid" | "unpaid",
  additional: ManualBookingAdditionalOutcome | null | undefined,
  money: BoundClubFormat,
): string {
  if (!additional) return "";
  const amount = money.cents(additional.outstandingCents);
  if (direction === "unpaid") {
    return ` The ${amount} extra that settlement covered is owing again.`;
  }
  if (additional.settled) {
    return ` The ${amount} extra owing on this booking was recorded as settled too, so the member will not be asked for it again.`;
  }
  // #2397 (owner decision, 31 Jul 2026): naming the RECORDED figure matters
  // most here. This is the branch where the club deliberately books less than
  // the booking is worth, and the person who just took the cash has to see that
  // the two figures are meant to differ.
  //
  // #2397 F4: and they have to be told HOW the club gets the rest. Chasing a
  // member for money they have no way to send is the worst available outcome,
  // so the settlement leaves the addition's card door open where one exists and
  // this sentence says which of the two situations they are in.
  return (
    ` Only ${money.cents(additional.recordedAmountCents)} was recorded as received: the ${amount} extra was left unpaid, so the member will still be asked for it.` +
    (additional.payableOnline
      ? ` They can pay it themselves from their booking page.`
      : ` They have no card payment set up for it, so someone will need to contact them to collect it.`)
  );
}

/**
 * POST /api/admin/bookings/[id]/mark-paid
 *
 * B5 (#2262). Record a booking's payment as settled in cash / by an off-Xero
 * bank transfer (direction: "paid"), or reverse a prior manual settlement
 * (direction: "unpaid"). Gated finance:edit. Audited both ways. NEVER calls
 * Xero and NEVER creates or voids an invoice.
 *
 * #2260 notifyMember contract (422 either way it is broken):
 *  - direction "paid" REQUIRES notifyMember. It is a real choice with a real
 *    consequence — a member gets a booking confirmation or does not — so absent
 *    must not silently mean either. An ambiguous call is refused, not guessed.
 *  - direction "unpaid" REJECTS notifyMember. A reversal emails nobody, so
 *    accepting the field would let a caller believe it had asked for something.
 *
 * `expectedAmountCents` follows the same shape: required when marking paid
 * (there is nothing to reconcile the admin's figure against without it) and
 * rejected on the reversal, which settles no amount.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const money = await clubFormat();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid manual payment request.", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { direction, notifyMember, expectedAmountCents, additionalCoverage } =
    parsed.data;
  if (direction === "paid" && notifyMember === undefined) {
    return NextResponse.json(
      {
        error:
          "Say whether the member should be emailed: notifyMember is required when recording a booking payment.",
      },
      { status: 422 },
    );
  }
  if (direction === "unpaid" && notifyMember !== undefined) {
    return NextResponse.json(
      {
        error:
          "Reversing a manual payment never emails the member, so notifyMember cannot be sent with direction \"unpaid\".",
      },
      { status: 422 },
    );
  }
  if (direction === "paid" && expectedAmountCents === undefined) {
    return NextResponse.json(
      {
        error:
          "expectedAmountCents is required when recording a booking payment, so a price that moved since the dialog opened is refused rather than recorded.",
      },
      { status: 422 },
    );
  }
  if (direction === "unpaid" && expectedAmountCents !== undefined) {
    return NextResponse.json(
      {
        error:
          "Reversing a manual payment settles no amount, so expectedAmountCents cannot be sent with direction \"unpaid\".",
      },
      { status: 422 },
    );
  }
  if (direction === "unpaid" && additionalCoverage !== undefined) {
    return NextResponse.json(
      {
        error:
          "Reversing a manual payment always puts an extra it settled back to owing, so additionalCoverage cannot be sent with direction \"unpaid\".",
      },
      { status: 422 },
    );
  }

  try {
    const result = await applyManualBookingPayment(
      direction === "paid"
        ? {
            bookingId: id,
            direction: "paid",
            note: parsed.data.note ?? null,
            actingMemberId: guard.session.user.id,
            notifyMember: notifyMember === true,
            expectedAmountCents: expectedAmountCents as number,
            additionalCoverage: additionalCoverage ?? null,
          }
        : {
            bookingId: id,
            direction: "unpaid",
            note: parsed.data.note ?? null,
            actingMemberId: guard.session.user.id,
          },
    );
    revalidatePath("/admin/bookings");
    revalidatePath("/admin/bookings/[id]", "page");
    revalidatePath("/admin/payments");
    return NextResponse.json({
      success: true,
      booking: result,
      // #2260: report what became of the confirmation, never a delivery claim
      // the code cannot make. "queued" means the mailer accepted it — the
      // per-booking No-emails switch, a suppressed recipient, a club-internal
      // placeholder address or an outright failure all come back as
      // not_delivered and say so.
      message:
        (result.direction === "paid"
          ? result.receipt === "queued"
            ? "Payment recorded. A booking confirmation is being emailed to the member."
            : result.receipt === "not_delivered"
              ? "Payment recorded, but the confirmation could not be sent — check the booking's email settings and the member's address."
              : "Payment recorded. The member was not emailed."
          : "Manual payment reversed. The booking is unpaid again and was not cancelled.") +
        // #2265 (#2262 door 3): the credit election, reported to the admin
        // SYNCHRONOUSLY. The operator alert that also reports it is gated on the
        // club's `adminPaymentFailure` preference, which a club may have muted,
        // so the person who just took the cash must hear it here regardless.
        creditElectionNote(result.direction, result.creditElectionCents, money) +
        // #2397: what became of the booking's outstanding extra — reported the
        // same way and for the same reason as the credit election above.
        additionalNote(result.direction, result.additional, money),
    });
  } catch (error) {
    const hostingRetry = hostingCoverageParticipantRetryResponse(error);
    if (hostingRetry) return hostingRetry;
    if (error instanceof ManualBookingPaymentError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error({ err: error, bookingId: id }, "Manual booking payment failed");
    return NextResponse.json(
      { error: "Manual booking payment failed." },
      { status: 500 },
    );
  }
}
