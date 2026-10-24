import { NextRequest, NextResponse } from "next/server";
import { PaymentSource } from "@prisma/client";
import { bookingOwner } from "@/lib/booking-owner";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { createAuditLog } from "@/lib/audit";
import { isXeroConnected } from "@/lib/xero";
import { kickQueuedXeroOutboxOperationsIfConnected } from "@/lib/xero-operation-outbox";
import { sendEmail } from "@/lib/email";
import {
  refundRequestApprovedTemplate,
  refundRequestDeclinedTemplate,
} from "@/lib/email-templates/refunds";
import {
  composeOptionalEmailLine,
} from "@/lib/email-message-notes";
import logger from "@/lib/logger";
import { raiseRefundRequestHandBack, refundAppealHandedBackParts, totalRefundAppealHandedBackCents } from "@/lib/edit-refund-hand-back";
import { getRemainingRefundableCentsNetOf } from "@/lib/booking-payment-state";
import { refundRequestHandBackOccurrenceKey } from "@/lib/manual-refund-task-settlement-rules";
import {
  lockPaymentForRefundedTotal,
  planStripeRefundAllocation,
  refundPaymentTransactions,
} from "@/lib/payment-transactions";
import { inlineRefundAfterAttempt } from "@/lib/refused-card-refund-retry";
import { NO_CARD_REFUND_OWED, queueUnmadeRefundRequestCardRefund, refundRequestCardRefundAnswer } from "@/lib/refund-request-card-refund";
import { buildRefundRequestRefundMetadata, buildRefundRequestRefundStripeKeyPrefix } from "@/lib/payment-recovery-keys";
import { notesEachCardRefund, queueRefundRequestCardNotes } from "@/lib/card-refund-own-note";
import { CLUB_BOOKINGS_NAME } from "@/config/club-identity";
import { formatStayDate } from "@/lib/club-time";
import { clubFormat } from "@/lib/club-format-server";
import { renderEmailHtml } from "@/lib/email-theme";
import { refundRequestApprovedRefundSentence } from "@/lib/booking-modified-email-copy";
import { bankTransferRefundPayee } from "@/lib/group-organiser-paid";
import { GroupCancelInProgressError } from "@/lib/group-cancel-in-progress";
import {
  OrganiserChildRefundRefusedError,
  organiserCardAppealCap,
  reserveOrganiserChildAppealRefund,
} from "@/lib/organiser-child-refund";
import {
  notifyOrganiserOfJoinerAppealRefund,
  runOrganiserChildAppealRefundNow,
} from "@/lib/organiser-child-appeal-refund";

/** #3827 (`INV-PAY-118`): thrown inside the approval to roll its claim back. */
class RefundRequestHandBackNotRaisedError extends Error {}

const reviewSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED"]),
  adminNotes: z.string().max(2000).optional(),
  approvedAmountCents: z.number().int().min(0).optional(),
  // #1792: admin per-action email choice. Absent/undefined = notify (default);
  // false = suppress the member outcome email. A non-boolean is rejected 400 by
  // this parse. Only affects the outcome notice — refund execution, ledger math,
  // and Stripe/Xero are unchanged.
  notifyMember: z.boolean().optional(),
});

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const { id } = await params;
  const money = await clubFormat();

  const refundRequest = await prisma.refundRequest.findUnique({
    where: { id },
    include: {
      // #3369: the owner may be an Organisation; bookingOwner() reads both.
      booking: { include: { payment: true, member: true, organisation: { select: { name: true, email: true } } } },
      member: true,
    },
  });

  if (!refundRequest) {
    return NextResponse.json({ error: "Refund request not found" }, { status: 404 });
  }

  if (refundRequest.status !== "PENDING") {
    return NextResponse.json(
      { error: "This refund request has already been reviewed" },
      { status: 400 }
    );
  }

  const body = await req.json();
  const parsed = reviewSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { status, adminNotes, approvedAmountCents, notifyMember } = parsed.data;
  const booking = refundRequest.booking;
  const payment = booking.payment;

  let cardRefund = NO_CARD_REFUND_OWED; // #4117: what its card refund left unmade, queued or not, and why
  let madeSlices: ReadonlyArray<{ madeRefundId?: string }> = []; // #4312: the refunds its inline attempt made
  if (status === "APPROVED") {
    if (!approvedAmountCents || approvedAmountCents <= 0) {
      return NextResponse.json(
        { error: "Approved amount is required for approval" },
        { status: 400 }
      );
    }

    if (!payment) {
      return NextResponse.json(
        { error: "No payment found for this booking" },
        { status: 400 }
      );
    }

    // B5 (#2262): this booking was settled in cash / by an off-Xero bank
    // transfer, so there is NO Stripe money to refund. Approving here would
    // plan $0, log the drift, tell the member their refund is on its way, and
    // hand nothing back — the exact silent-$0 hazard this feature exists to
    // avoid. Refuse and point at the flow that can actually return the money.
    //
    // #3827 (D-3813-7) does NOT lift this, though an approval can now raise a
    // bank-transfer task and its cap nets the cancellation's own open
    // hand-back (`INV-PAY-118`): once that task is paid it moves
    // `refundedAmountCents`, but a dismissed one (the club decided to keep the
    // money) reads as refundable again, so an appeal here could re-promise
    // money the treasurer already decided on. Kept for the owner to revisit.
    // An appeal exists only on a cancelled booking, so the message must not
    // tell the officer to cancel it.
    if (payment.manuallyMarkedPaidAt) {
      return NextResponse.json(
        {
          error:
            "This booking was paid in cash or by an off-Xero bank transfer, so there is no card payment to refund and this appeal cannot be approved here. Its cancellation already raised a refund task on the payments board for the money the cancellation policy returns; settle any further refund with the treasurer.",
        },
        { status: 409 }
      );
    }

    // #3827 (`INV-PAY-118`): cap at the refundable cash NET of every refund
    // still promised back by bank transfer - an edit's, an earlier approved
    // appeal's (D-3813-7), or a cancellation's own hand-back - and of the
    // account credit already minted from late cash, or an appeal re-promises
    // money the member holds or is being sent (paid 200, an edit to 150 leaves
    // a 50 task OPEN), and (#4124) of card refunds still owed. Read under
    // `lock(1)` and the Payment row; claimed in the same transaction.
    const capped = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      // #3956 review: a request another approval or decline settled while this
      // one waited for the lock is "already reviewed", never a cap refusal read
      // from money that approval has since spoken for. The claim below stays the
      // authority; this re-read only puts the answer before the cap.
      const current = await tx.refundRequest.findUnique({ where: { id }, select: { status: true } });
      if (current?.status !== "PENDING") return { kind: "lost" as const };
      // #4124 F2 (`INV-LOCK-002`): the Payment row, BEFORE every read below, so no
      // writer holding it without `lock(1)` (a hand-back's completion, a refund's
      // record, a failed-later debt) lands between them (`RefundAppealHandedBack`).
      await lockPaymentForRefundedTotal(tx, payment.id);
      const handedBack = await refundAppealHandedBackParts(tx, {
        id: payment.id,
        bookingId: booking.id,
      });
      const lockedPayment = await tx.payment.findUnique({
        where: { id: payment.id },
        select: {
          id: true,
          source: true,
          status: true,
          amountCents: true,
          refundedAmountCents: true,
        },
      });
      const maxRefundable = getRemainingRefundableCentsNetOf(lockedPayment, totalRefundAppealHandedBackCents(handedBack));
      // #3956 (`INV-PAY-123`): a joiner's booking the group organiser paid for
      // by card has no transaction of its own to plan a refund from - the money
      // sits in the organiser's combined payment, so its appeal is refunded out
      // of that payment (#3653, `INV-PAY-114`) and capped at what it can still
      // return. Over that, the approval is refused naming what can still be
      // refunded (owner decision), never clamped.
      const organiserCard = lockedPayment
        ? await organiserCardAppealCap(tx, booking, lockedPayment, handedBack)
        : null;
      if (organiserCard) {
        if (organiserCard.combinedRefundPending) return { kind: "organiserCardCombinedRefundPending" as const };
        if (!organiserCard.settlement || approvedAmountCents > organiserCard.maxRefundableCents) {
          return { kind: "organiserCardShort" as const, maxRefundable: organiserCard.maxRefundableCents };
        }
      } else if (approvedAmountCents > maxRefundable) {
        return { kind: "exceeds" as const, maxRefundable };
      }
      // Claim the request before moving any money. Winning the PENDING ->
      // APPROVED transition is what authorises the refund, so two admins
      // approving the same request concurrently cannot both issue a Stripe
      // refund — the loser gets a 409 and never calls Stripe (issue #818).
      const claim = await tx.refundRequest.updateMany({
        where: { id, status: "PENDING" },
        data: {
          status: "APPROVED",
          adminNotes,
          approvedAmountCents,
          reviewedBy: session.user.id,
          reviewedAt: new Date(),
        },
      });
      if (claim.count !== 1) return { kind: "lost" as const };

      if (organiserCard?.settlement && lockedPayment) {
        // Step 1 of `INV-PAY-114`: the debt, frozen at the approved amount and
        // keyed by this request, in the transaction that claimed it. Stripe is
        // asked after the commit; nothing is called refunded until it answers.
        const debt = await reserveOrganiserChildAppealRefund(tx, {
          settlement: organiserCard.settlement,
          refundRequestId: id,
          childBookingId: booking.id,
          childPayment: lockedPayment,
          amountCents: approvedAmountCents,
        });
        return {
          kind: "claimed" as const,
          refundPlan: [],
          plannedAmountCents: 0,
          bankTransferCents: 0,
          organiserChildDebtId: debt.id as string | null,
        };
      }

      // #1510: freeze the refund allocation the inline attempt will execute and
      // pass the SAME slices to both the inline refund and the durable recovery
      // enqueue below, mirroring the booking-cancellation frozen plan (#1349).
      // For a multi-transaction payment with partial refund progress, deriving a
      // fresh newest-first plan at replay time — over ledger state the completed
      // slices have already moved — would compute different slice amounts, and
      // therefore different `refund_request_<id>_<txn>_<amount>` Stripe
      // idempotency keys, so the replay would mint NEW refunds instead of
      // replaying the originals. Freezing the plan makes the replay re-request
      // byte-identical slices under identical keys, which Stripe answers with the
      // original refunds (the PaymentRefund ledger dedupes on refund id). This
      // also makes the inline path deterministic. Planned here, under the lock,
      // because the part it cannot carry decides the task below.
      const plan = await planStripeRefundAllocation({
        paymentId: payment.id,
        amountCents: approvedAmountCents,
        store: tx,
      });

      // #3827 (owner decision D-3813-7, `INV-PAY-118`): on a booking paid by
      // internet banking, what no card refund can carry (normally all of it)
      // goes back by bank transfer. ONE officer task, raised here so it is
      // netted from the refundable cash before the lock is released - a second
      // appeal cannot be approved against the same money - and keyed on this
      // request, so it can never be raised twice. Only for that source: a card
      // payment whose ledger plans short of the approved amount is ledger
      // drift, logged after the commit and refunded as far as the plan goes,
      // exactly as before - never turned into a bank transfer nobody chose.
      const bankTransferCents =
        lockedPayment?.source === PaymentSource.INTERNET_BANKING
          ? Math.max(approvedAmountCents - plan.plannedAmountCents, 0)
          : 0;
      if (bankTransferCents > 0) {
        const raised = await raiseRefundRequestHandBack(tx, {
          bookingId: booking.id,
          paymentId: payment.id,
          refundRequestId: id,
          amountCents: bankTransferCents, booking: { ...booking, payment: lockedPayment }, // #3949: names the payee
        });
        // A row already holds this request's key (left by an earlier approval
        // of it), so nobody would be asked to send this money. Refuse rather
        // than promise a transfer with no task behind it; the throw rolls the
        // claim back with it.
        if (raised === 0) throw new RefundRequestHandBackNotRaisedError();
      }
      return {
        kind: "claimed" as const,
        refundPlan: plan.slices,
        plannedAmountCents: plan.plannedAmountCents,
        bankTransferCents,
        organiserChildDebtId: null as string | null,
      };
    }).catch((err: unknown) => {
      if (err instanceof RefundRequestHandBackNotRaisedError) {
        return { kind: "handBackNotRaised" as const };
      }
      // Thrown after the claim, so the claim rolls back with it.
      if (err instanceof OrganiserChildRefundRefusedError || err instanceof GroupCancelInProgressError) {
        return { kind: "organiserCardRefused" as const, message: err.message };
      }
      throw err;
    });

    if (capped.kind === "exceeds") {
      return NextResponse.json(
        {
          error: `Amount exceeds maximum refundable of ${money.cents(capped.maxRefundable)}`,
        },
        { status: 400 }
      );
    }

    if (capped.kind === "organiserCardCombinedRefundPending") {
      return NextResponse.json(
        {
          error:
            "This booking was paid for by the group organiser's card, and the group cancellation's own refund to that card is still being made or reconciled, so this appeal cannot be approved now. Approve it once that refund is made, or decline it.",
          maxRefundableCents: 0,
        },
        { status: 409 }
      );
    }

    if (capped.kind === "organiserCardShort") {
      // #3956 review: with nothing left there is no smaller amount to approve,
      // so the officer is told to decline rather than to approve "$0.00 or less".
      return NextResponse.json(
        {
          error:
            capped.maxRefundable > 0
              ? `This booking was paid for by the group organiser's card, and that payment can refund at most ${money.cents(capped.maxRefundable)} more for it, so an appeal for ${money.cents(approvedAmountCents)} cannot be approved. Approve ${money.cents(capped.maxRefundable)} or less, or decline the appeal.`
              : "This booking was paid for by the group organiser's card, and that payment has nothing left to refund for it, so this appeal cannot be approved. Decline it.",
          maxRefundableCents: capped.maxRefundable,
        },
        { status: 409 }
      );
    }

    if (capped.kind === "organiserCardRefused") {
      return NextResponse.json({ error: capped.message }, { status: 409 });
    }

    if (capped.kind === "lost") {
      return NextResponse.json(
        { error: "This refund request has already been reviewed" },
        { status: 409 }
      );
    }

    if (capped.kind === "handBackNotRaised") {
      logger.error(
        { refundRequestId: id, paymentId: payment.id },
        "Refund appeal not approved: a bank-transfer task already holds this request's key, so no new task could be raised (#3827)"
      );
      return NextResponse.json(
        {
          error:
            "This appeal already has a bank-transfer refund task from an earlier approval, so it was not approved again. Check the payments board before approving it.",
        },
        { status: 409 }
      );
    }

    const { refundPlan, plannedAmountCents, bankTransferCents, organiserChildDebtId } = capped;

    // #3956: the organiser-card refund runs now, outside any transaction; a
    // failure leaves its debt owed for the recovery runner. Its Xero note is
    // the executor's, once Stripe answers - this route queues none.
    const organiserCardRefundMade = organiserChildDebtId
      ? await runOrganiserChildAppealRefundNow(organiserChildDebtId, id, money.format)
      : false;

    if (!organiserChildDebtId && bankTransferCents === 0 && plannedAmountCents < approvedAmountCents) {
      // A card payment whose ledger shows less Stripe-refundable than the
      // approved amount (e.g. a mixed Stripe + Internet Banking payment, whose
      // IB portion is settled by the Xero credit note below, not Stripe):
      // refund what the ledger shows Stripe-refundable, mirroring the
      // booking-cancel drift log (#1349).
      logger.error(
        {
          refundRequestId: id,
          paymentId: payment.id,
          approvedAmountCents,
          plannedAmountCents,
        },
        "Approved refund appeal plan covers less than the approved amount; refunding what the payment ledger shows Stripe-refundable"
      );
    }

    if (!organiserChildDebtId) {
      let attempt: Parameters<typeof inlineRefundAfterAttempt>[1];
      const attemptedAt = new Date(); // #4117: a refund Stripe makes from here is this attempt's
      try {
        attempt = await refundPaymentTransactions({
          format: money.format,
          paymentId: payment.id,
          amountCents: plannedAmountCents,
          allocation: refundPlan,
          // #1507: build the Stripe metadata from the shared helper so the
          // recovery cron's replay (under the same refund_request_<id> key) sends
          // a byte-identical body and Stripe replays the original refund instead
          // of rejecting the reused idempotency key with idempotency_error.
          metadata: buildRefundRequestRefundMetadata(booking.id, id),
          idempotencyKeyPrefix: buildRefundRequestRefundStripeKeyPrefix(id),
        });
      } catch (err) {
        // The approval stands: complete the refund through the durable payment
        // recovery queue instead of releasing the claim (#1039 item 1, PR #846
        // residual). Bouncing back to PENDING would create two retry paths —
        // a second admin approval and the recovery cron — with two distinct
        // Stripe idempotency scopes for the same money. The recovery operation
        // reuses the original refund_request_<id> Stripe key prefix, so a
        // refund that succeeded on Stripe without being recorded is replayed,
        // not repeated.
        logger.error(
          { err, refundRequestId: id },
          "Stripe refund failed for approved appeal - enqueueing durable recovery"
        );
        attempt = { error: err };
      }
      // Persist the frozen plan with what the inline attempt did NOT make still
      // to send (#1510; #3924 F1): the cron replays those keys. #4102, #4117
      // (`INV-PAY-128`): a slice Stripe refused is among them on its next key;
      // one that threw or was never sent keeps its key; a made one is marked.
      const read = inlineRefundAfterAttempt(refundPlan, attempt);
      madeSlices = read.plan;
      const outcome = await queueUnmadeRefundRequestCardRefund({
        bookingId: booking.id,
        paymentId: payment.id,
        refundRequestId: id,
        read,
        paymentIntentIdFallback: payment.stripePaymentIntentId ?? "",
        notesEachRefund: await notesEachCardRefund(payment), // #4312: the replay notes each refund it makes
        format: money.format,
      });
      cardRefund = refundRequestCardRefundAnswer(read, outcome, attemptedAt);
      if (outcome === "release_claim") {
        // No durable row could be written and Stripe was never asked: fall
        // back to the pre-#1039 behaviour and release the claim so an admin
        // can retry manually.
        // #3827 (D-3813-7): the bank-transfer task this approval raised goes
        // with the claim, in one transaction under the same lock, or a retried
        // approval would find its key taken and its cash already netted.
        await prisma
          .$transaction(async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
            const released = await tx.refundRequest.updateMany({
              where: { id, status: "APPROVED" },
              data: {
                status: "PENDING",
                approvedAmountCents: null,
                reviewedBy: null,
                reviewedAt: null,
              },
            });
            if (released.count === 1) {
              await tx.manualRefundTask.deleteMany({
                where: {
                  occurrenceKey: refundRequestHandBackOccurrenceKey(id),
                  status: "OPEN",
                },
              });
            }
          })
          .catch((revertErr) => {
            logger.error(
              { err: revertErr, refundRequestId: id },
              "Failed to revert refund request claim after Stripe refund failure"
            );
          });
        return NextResponse.json(
          { error: "Failed to process Stripe refund" },
          { status: 500 }
        );
      }
    }

    // Queue the Xero credit note durably and try to kick the worker - for the
    // part refunded through the card only (the whole approval, on a card
    // payment, exactly as before). The bank-transfer part gets NO note here:
    // owner decision D-3813-8 (`INV-PAY-118`) queues that request's own note
    // when the treasurer marks its task paid back, after the money has moved
    // (`enqueueXeroRefundRequestCreditNoteOperation`). Nor does an
    // organiser-card refund (#3956): the executor queues its note with the
    // refund row, once Stripe has answered. #4312 (`INV-ADDPAY-047`): on a bank
    // transfer each refund the attempt made is noted on its own record, and
    // the recovery replay notes those it makes (`queueRefundRequestCardNotes`).
    const unqueuedCents = cardRefund.cardRefundQueued ? 0 : cardRefund.cardRefundOwedCents; // #4117: not refunded, so not noted
    const cardNoteCents = organiserChildDebtId ? 0 : approvedAmountCents - bankTransferCents - unqueuedCents;
    try {
      const queuedCreditNote = organiserChildDebtId
        ? { queueOperationId: null }
        : await queueRefundRequestCardNotes({ payment, cardNoteCents, plan: madeSlices, createdByMemberId: session.user.id });

      if (queuedCreditNote.queueOperationId && (await isXeroConnected())) {
        void kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 }).catch((xeroErr) => {
          logger.error(
            { err: xeroErr, refundRequestId: id, paymentId: payment.id },
            "Failed to kick Xero refund credit note outbox worker for refund appeal"
          );
        });
      }
    } catch (xeroErr) {
      logger.error(
        { err: xeroErr, refundRequestId: id },
        "Failed to queue Xero credit note for refund appeal"
      );
    }

    // #1792: resolve the member email BEFORE the audit so the notify choice can
    // be recorded honestly. Only stamp notifyMember:false when there was an
    // email to suppress; otherwise there was nothing to opt out of.
    const memberEmail = bookingOwner(booking).member.email || refundRequest.member.email;
    // #3369: the owner where there is a member to name, and otherwise the
    // person who ASKED for the refund — who is always a member, because
    // `RefundRequest.memberId` is the requester and stays required. A school's
    // booking therefore still addresses somebody real.
    const recipientMemberId =
      (bookingOwner(booking).member.email
        ? bookingOwner(booking).member.id
        : refundRequest.member.id) ?? refundRequest.member.id;
    const notifyAuditFields =
      memberEmail && notifyMember === false ? { notifyMember: false } : {};

    await createAuditLog({
      action: "refund-request.approve",
      memberId: session.user.id,
      targetId: id,
      subjectMemberId: bookingOwner(booking).memberId,
      entityType: "RefundRequest",
      entityId: id,
      category: "payment",
      outcome: "success",
      summary: "Refund appeal approved",
      details: `Approved refund appeal for ${money.cents(approvedAmountCents)} on booking ${booking.id}`,
      metadata: {
        bookingId: booking.id,
        approvedAmountCents,
        // #3827 (D-3813-7): the part raised as a bank-transfer officer task.
        bankTransferCents,
        // #3956: refunded to the group organiser's card through this debt.
        ...(organiserChildDebtId
          ? { organiserCardRefundOperationId: organiserChildDebtId, organiserCardRefundMade: organiserCardRefundMade }
          : {}),
        ...cardRefund, // #4117: what the card refund left unmade; the list reads it when no row was written
        ...notifyAuditFields,
      },
      ipAddress: req.headers.get("x-forwarded-for") ?? "unknown",
    });

    // #3956: where the refund goes to the organiser's card, the joiner is told
    // so - made, or on its way while Stripe has not answered.
    const organiserCardRefund = !organiserChildDebtId ? null
      : organiserCardRefundMade ? "organiser_card" : "organiser_card_pending";

    // Email the member unless the admin chose not to notify (#1792).
    if (memberEmail && notifyMember !== false) {
      sendEmail({
        to: memberEmail,
        subject: `Refund Appeal Approved — ${CLUB_BOOKINGS_NAME}`,
        html: await renderEmailHtml(() => refundRequestApprovedTemplate({
          firstName: refundRequest.member.firstName,
          amountCents: approvedAmountCents,
          bankTransferCents,
          organiserCardRefund, bankTransferPayee: bankTransferRefundPayee(booking), // #3949
          adminNotes: adminNotes ?? null,
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
        }, money.format)),
        // Member-facing and booking-scoped: the per-booking "No emails"
        // switch withholds it (#2258).
        bookingContext: {
          bookingId: booking.id,
          recipient: { kind: "member", memberId: recipientMemberId },
        },
        templateName: "refund-request-approved",
        templateData: {
          firstName: refundRequest.member.firstName,
          // #2321: {{status}} is gone — the template name carries the
          // outcome, and a flat body could never have branched on it.
          amount: money.cents(approvedAmountCents),
          // #3827 (D-3813-7): the refund promised by bank transfer, or reported
          // to the card - the same sentence the HTML template renders.
          refundSentence: refundRequestApprovedRefundSentence(
            approvedAmountCents,
            bankTransferCents,
            money.cents,
            organiserCardRefund, bankTransferRefundPayee(booking), // #3949: the group organiser, when they paid by internet banking
          ),
          adminNotes: adminNotes ?? "",
          // #2268: pre-composed optional line — the flat body has no
          // conditional syntax, so a resolution with no admin note must not
          // print a bare "Notes:" heading over nothing.
          adminNotesLine: composeOptionalEmailLine("Notes", adminNotes),
          // Lodge nights are CALENDAR DAYS (`@db.Date`), rendered with no zone at all
          // (CT-4, #2870). The zoned instant formatter this replaced projected UTC
          // midnight through the club zone: the identity in New Zealand, and the
          // PREVIOUS DAY for any club behind UTC.
          checkIn: formatStayDate(booking.checkIn, money.format),
          checkOut: formatStayDate(booking.checkOut, money.format),
        },
      }).catch((err) =>
        logger.error({ err }, "Failed to send refund appeal approved email")
      );
    }

    // #3956 (owner decision): the organiser is told too - it is their card the
    // money goes back to. The same notify choice governs both outcome emails.
    if (organiserChildDebtId && booking.parentBookingId && notifyMember !== false) {
      await notifyOrganiserOfJoinerAppealRefund({
        refundRequestId: id,
        organiserBookingId: booking.parentBookingId,
        joinerName: `${bookingOwner(booking).member.firstName} ${bookingOwner(booking).member.lastName}`.trim(),
        joinerEmail: memberEmail,
        amountCents: approvedAmountCents,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        format: money.format,
      });
    }
  } else {
    // REJECTED
    const rejected = await prisma.refundRequest.updateMany({
      where: { id, status: "PENDING" },
      data: {
        status: "REJECTED",
        adminNotes,
        approvedAmountCents: 0,
        reviewedBy: session.user.id,
        reviewedAt: new Date(),
      },
    });

    if (rejected.count !== 1) {
      return NextResponse.json(
        { error: "This refund request has already been reviewed" },
        { status: 409 }
      );
    }

    // #1792: resolve the member email BEFORE the audit so the notify choice can
    // be recorded honestly. Only stamp notifyMember:false when there was an
    // email to suppress; otherwise there was nothing to opt out of.
    const memberEmail = bookingOwner(booking).member.email || refundRequest.member.email;
    // #3369: the owner where there is a member to name, and otherwise the
    // person who ASKED for the refund — who is always a member, because
    // `RefundRequest.memberId` is the requester and stays required. A school's
    // booking therefore still addresses somebody real.
    const recipientMemberId =
      (bookingOwner(booking).member.email
        ? bookingOwner(booking).member.id
        : refundRequest.member.id) ?? refundRequest.member.id;
    const notifyAuditFields =
      memberEmail && notifyMember === false ? { notifyMember: false } : {};

    await createAuditLog({
      action: "refund-request.reject",
      memberId: session.user.id,
      targetId: id,
      subjectMemberId: bookingOwner(booking).memberId,
      entityType: "RefundRequest",
      entityId: id,
      category: "payment",
      outcome: "success",
      summary: "Refund appeal rejected",
      details: `Rejected refund appeal for booking ${booking.id}`,
      metadata: {
        bookingId: booking.id,
        adminNotes: adminNotes ?? null,
        ...notifyAuditFields,
      },
      ipAddress: req.headers.get("x-forwarded-for") ?? "unknown",
    });

    // Email the member unless the admin chose not to notify (#1792).
    if (memberEmail && notifyMember !== false) {
      sendEmail({
        to: memberEmail,
        subject: `Refund Appeal Update — ${CLUB_BOOKINGS_NAME}`,
        html: await renderEmailHtml(() => refundRequestDeclinedTemplate({
          firstName: refundRequest.member.firstName,
          adminNotes: adminNotes ?? null,
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
        })),
        // Member-facing and booking-scoped: the per-booking "No emails"
        // switch withholds it (#2258).
        bookingContext: {
          bookingId: booking.id,
          recipient: { kind: "member", memberId: recipientMemberId },
        },
        templateName: "refund-request-declined",
        templateData: {
          firstName: refundRequest.member.firstName,
          // #2321: NO amount is supplied on a decline — there is no refund
          // to state. The token is not in this template's allowed set
          // either, so an override that reaches for {{amount}} is refused
          // at save time rather than rendering an empty figure into
          // "A refund of  will be processed".
          adminNotes: adminNotes ?? "",
          // #2268: pre-composed optional line (see the approved branch).
          adminNotesLine: composeOptionalEmailLine("Notes", adminNotes),
          // Calendar days, no zone — see the approved branch above.
          checkIn: formatStayDate(booking.checkIn, money.format),
          checkOut: formatStayDate(booking.checkOut, money.format),
        },
      }).catch((err) =>
        logger.error({ err }, "Failed to send refund appeal declined email")
      );
    }
  }

  const updated = await prisma.refundRequest.findUnique({
    where: { id },
    include: {
      booking: {
        select: {
          id: true,
          checkIn: true,
          checkOut: true,
          finalPriceCents: true,
          status: true,
          payment: {
            select: {
              amountCents: true,
              refundedAmountCents: true,
            },
          },
        },
      },
      member: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
    },
  });

  return NextResponse.json({ ...updated, ...cardRefund });
}
