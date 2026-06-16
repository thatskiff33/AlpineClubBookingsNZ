import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { notFound, redirect } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { formatCents } from "@/lib/utils";
import { CancelBookingButton } from "@/components/cancel-booking-button";
import { BookingPaymentSection } from "@/components/booking-payment-section";
import { BookingNotesEditor } from "@/components/booking-notes-editor";
import { BookingEditor, type BookingEditorData } from "@/components/booking-editor";
import { AdditionalPaymentCard } from "@/components/additional-payment-card";
import { ConfirmDraftButton } from "@/components/confirm-draft-button";
import { ConfirmPendingGuestsButton } from "@/components/admin/confirm-pending-guests-button";
import { ArrivalTimeEditor } from "@/components/arrival-time-editor";
import { RequestedRoomEditor } from "@/components/requested-room-editor";
import { WaitlistOfferCard } from "@/components/waitlist-offer-card";
import { DeleteBookingButton } from "@/components/delete-booking-button";
import { CopyBookingButton } from "@/components/admin/copy-booking-button";
import { getBookingEditPolicy } from "@/lib/booking-edit-policy";
import { getBookingPaymentMode } from "@/lib/booking-payment-flow";
import { RefundAppealButton } from "@/components/refund-appeal-button";
import { paymentStatusClass } from "@/lib/status-colors";
import {
  getCancellationSettlementBreakdown,
  getPaymentDisplayStatus,
} from "@/lib/payment-status-display";
import {
  buildBookingHistoryItems,
  type BookingHistoryTone,
} from "@/lib/booking-history";
import {
  resolveBookingNarrative,
  type BookingNarrativeState,
  type NarrativeEvent,
} from "@/lib/booking-narrative";
import {
  getRemainingRefundableCents,
  hasCapturedPayment,
} from "@/lib/booking-payment-state";
import { isBookingFullyPaidForGuestNameEdits } from "@/lib/booking-modify";
import { isPaymentOwedBookingStatus } from "@/lib/booking-status";
import { isBookingBedAllocationLocked } from "@/lib/admin-bed-allocation";
import { loadEmailMessageSettings } from "@/lib/email-message-settings";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { resolveInternalReturnPath } from "@/lib/internal-return-path";

const historyToneClasses: Record<BookingHistoryTone, string> = {
  default: "border-slate-200 bg-slate-100 text-slate-700",
  success: "border-emerald-200 bg-emerald-100 text-emerald-800",
  warning: "border-amber-200 bg-amber-100 text-amber-800",
  danger: "border-rose-200 bg-rose-100 text-rose-800",
};

// States with a self-contained outcome worth surfacing as a banner. Active
// states (payable / under_review) already have their own dedicated UI below.
const NARRATIVE_BANNER_STATES = new Set<BookingNarrativeState>([
  "paid",
  "bumped",
  "cancelled_pre_payment",
  "cancelled_post_payment",
  "declined",
]);

const narrativeBannerClasses: Record<string, string> = {
  paid: "border-emerald-200 bg-emerald-50 text-emerald-900",
  bumped: "border-sky-200 bg-sky-50 text-sky-900",
  cancelled_pre_payment: "border-amber-200 bg-amber-50 text-amber-900",
  cancelled_post_payment: "border-amber-200 bg-amber-50 text-amber-900",
  declined: "border-rose-200 bg-rose-50 text-rose-900",
};

export default async function BookingDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ returnTo?: string | string[] }>;
}) {
  const { id } = await params;
  const query = searchParams ? await searchParams : {};
  const session = await auth();
  if (!session) redirect("/login");

  const booking = await prisma.booking.findUnique({
    where: { id },
    include: {
      guests: { include: { nights: { select: { stayDate: true } } } },
      payment: true,
      member: { select: { firstName: true } },
      requestedRoom: {
        select: { id: true, name: true, active: true },
      },
      promoRedemption: {
        include: {
          promoCode: {
            select: {
              code: true,
              type: true,
              description: true,
              internal: true,
              workPartyEvent: { select: { name: true } },
            },
          },
        },
      },
      creditsFromCancellation: {
        select: {
          amountCents: true,
          description: true,
        },
      },
      modifications: {
        orderBy: { createdAt: "desc" },
      },
      refundRequests: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          reason: true,
          requestedAmountCents: true,
          approvedAmountCents: true,
          adminNotes: true,
          createdAt: true,
          reviewedAt: true,
        },
      },
      changeRequests: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          reason: true,
          adminNotes: true,
          requestedChanges: true,
          createdAt: true,
          reviewedAt: true,
        },
      },
      createdBy: {
        select: { firstName: true, lastName: true },
      },
      deletedBy: {
        select: { firstName: true, lastName: true, email: true },
      },
      adminReviewedBy: {
        select: { firstName: true, lastName: true },
      },
      // Split-booking group (#738): the member booking links to its provisional
      // non-member child(ren); the child links back to its member booking.
      parentBooking: {
        select: { id: true, status: true, finalPriceCents: true },
      },
      linkedBookings: {
        select: {
          id: true,
          status: true,
          finalPriceCents: true,
          hasNonMembers: true,
          guests: { select: { id: true } },
        },
      },
    },
  });

  if (!booking) notFound();
  if (booking.deletedAt && session.user.role !== "ADMIN") notFound();
  if (booking.memberId !== session.user.id && session.user.role !== "ADMIN") {
    redirect("/bookings");
  }

  const bookingAuditLogs = await prisma.auditLog.findMany({
    where: {
      targetId: booking.id,
      action: {
        in: [
          "booking.payment.confirmed",
          "booking.payment.failed",
          "booking.modification.payment.confirmed",
          "booking.modification.payment.failed",
          "booking.cancel",
          "booking.delete.draft",
          "booking.delete.cancelled.soft",
        ],
      },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      action: true,
      details: true,
      createdAt: true,
    },
  });

  // Durable lifecycle events (issue #740) drive the same plain-language
  // narrative shown on the public payment-link page, so guests and admins read
  // identical wording for every booking state.
  const bookingEvents = await prisma.bookingEvent.findMany({
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
  const bookingNarrative = resolveBookingNarrative({
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
    events: bookingEvents.map(
      (event): NarrativeEvent => ({
        type: event.type,
        occurredAt: event.occurredAt,
        amountCents: event.amountCents,
        reason: event.reason,
        snapshot: event.snapshot,
      })
    ),
  });

  const nights = Math.ceil(
    (new Date(booking.checkOut).getTime() - new Date(booking.checkIn).getTime()) /
      (1000 * 60 * 60 * 24)
  );

  const isDraft = booking.status === "DRAFT";
  const isWaitlisted = booking.status === "WAITLISTED";
  const isWaitlistOffered = booking.status === "WAITLIST_OFFERED";
  const isDeleted = Boolean(booking.deletedAt);
  const canCancel = !isDeleted && ["PAYMENT_PENDING", "CONFIRMED", "PAID", "PENDING", "WAITLISTED", "WAITLIST_OFFERED"].includes(booking.status);
  const showArrivalTime = !isDeleted && !["CANCELLED", "COMPLETED"].includes(booking.status);
  const modules = await loadEffectiveModuleFlags();
  const showRequestedRoom =
    !isDeleted && (modules.bedAllocation || Boolean(booking.requestedRoomId));
  // Issue #776: the booking owner may request a room until an admin confirms
  // (locks) the bed allocation; admins can always edit while the booking is
  // modifiable. Only check the lock when the editor will actually render and
  // the module is on (the admin route also gates on bedAllocation).
  const isBookingOwner = booking.memberId === session.user.id;
  const bedAllocationLocked =
    showRequestedRoom && modules.bedAllocation
      ? await isBookingBedAllocationLocked({ bookingId: booking.id })
      : false;
  const requestedRoomEditableStatus =
    booking.status !== "CANCELLED" && booking.status !== "COMPLETED";
  const editPolicy = getBookingEditPolicy({
    status: booking.status,
    role: session.user.role,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
  });
  const canModify = !isDeleted && editPolicy.canModify;
  const canEditRequestedRoom = isDeleted
    ? false
    : session.user.role === "ADMIN"
      ? canModify
      : // Members (owners) may request a room before and after payment, until
        // the lodge confirms beds. Not tied to the paid/edit policy.
        isBookingOwner &&
        modules.bedAllocation &&
        requestedRoomEditableStatus &&
        !bedAllocationLocked;
  const canEditNonMemberGuestNames =
    canModify && !isBookingFullyPaidForGuestNameEdits(booking);
  const cancellationSettlement = booking.payment
    ? getCancellationSettlementBreakdown(
        booking.payment.refundedAmountCents,
        booking.creditsFromCancellation
      )
    : null;
  const paymentDisplay = booking.payment
    ? getPaymentDisplayStatus({
        bookingStatus: booking.status,
        paymentStatus: booking.payment.status,
        refundedAmountCents: booking.payment.refundedAmountCents,
        credits: booking.creditsFromCancellation,
      })
    : null;
  const internetBankingPayment =
    booking.payment?.source === "INTERNET_BANKING" ? booking.payment : null;
  const originalPaymentCaptured = hasCapturedPayment(booking.payment);
  const retainedAfterCancellationCents = booking.payment
    ? Math.max(
        booking.payment.amountCents - booking.payment.refundedAmountCents,
        0
      )
    : 0;
  const latestRefundAppeal = booking.refundRequests[0] ?? null;
  const maxRefundableCents = getRemainingRefundableCents(booking.payment);
  const bookingHistory = buildBookingHistoryItems({
    createdAt: booking.createdAt,
    payment: booking.payment
      ? {
          status: booking.payment.status,
          amountCents: booking.payment.amountCents,
          refundedAmountCents: booking.payment.refundedAmountCents,
          additionalAmountCents: booking.payment.additionalAmountCents,
          additionalPaymentStatus: booking.payment.additionalPaymentStatus,
          createdAt: booking.payment.createdAt,
          updatedAt: booking.payment.updatedAt,
        }
      : null,
    modifications: booking.modifications,
    refundRequests: booking.refundRequests,
    auditLogs: bookingAuditLogs,
  });

  const editorData: BookingEditorData = {
    id: booking.id,
    checkIn: new Date(booking.checkIn).toISOString().split("T")[0],
    checkOut: new Date(booking.checkOut).toISOString().split("T")[0],
    nights,
    status: booking.status,
    guests: booking.guests.map((g) => ({
      id: g.id,
      firstName: g.firstName,
      lastName: g.lastName,
      ageTier: g.ageTier,
      isMember: g.isMember,
      memberId: g.memberId,
      stayStart: g.stayStart.toISOString().slice(0, 10),
      stayEnd: g.stayEnd.toISOString().slice(0, 10),
      priceCents: g.priceCents,
      nights: g.nights.map((n) => n.stayDate.toISOString().slice(0, 10)),
    })),
    bookingMemberId: booking.memberId,
    viewerRole: session.user.role,
    totalPriceCents: booking.totalPriceCents,
    discountCents: booking.discountCents,
    promoAdjustmentCents: booking.promoAdjustmentCents,
    finalPriceCents: booking.finalPriceCents,
    promo: booking.promoRedemption?.promoCode
      ? {
          code: booking.promoRedemption.promoCode.code,
          type: booking.promoRedemption.promoCode.type,
          description: booking.promoRedemption.promoCode.description,
          workPartyEventName:
            booking.promoRedemption.promoCode.workPartyEvent?.name ?? null,
        }
      : null,
    hasNonMembers: booking.hasNonMembers,
    nonMemberHoldUntil: booking.nonMemberHoldUntil?.toISOString() ?? null,
    canEditNonMemberGuestNames,
    editPolicy: {
      mode: editPolicy.mode,
      today: editPolicy.today.toISOString().slice(0, 10),
      editableFrom: editPolicy.editableFrom?.toISOString().slice(0, 10) ?? null,
      checkInEditable: editPolicy.checkInEditable,
    },
  };
  const backHref = resolveInternalReturnPath(
    query.returnTo,
    session.user.role === "ADMIN" ? "/admin/bookings" : "/bookings"
  );
  const canDeleteDraft =
    !isDeleted &&
    isDraft &&
    (session.user.role === "ADMIN" || booking.memberId === session.user.id);
  const canSoftDeleteCancelled =
    !isDeleted &&
    booking.status === "CANCELLED" &&
    session.user.role === "ADMIN";
  const showMemberArrivalInstructions =
    !isDeleted &&
    booking.memberId === session.user.id &&
    ["CONFIRMED", "PAID"].includes(booking.status);
  const memberArrivalInstructions = showMemberArrivalInstructions
    ? await loadEmailMessageSettings()
    : null;

  // Split-booking group presentation (#738).
  const linkedProvisionalChildren = booking.linkedBookings.filter(
    (linked) => linked.status === "PENDING"
  );
  const provisionalChildGuestCount = linkedProvisionalChildren.reduce(
    (total, linked) => total + linked.guests.length,
    0
  );
  const hasProvisionalChildren = provisionalChildGuestCount > 0;
  const isProvisionalChild = Boolean(booking.parentBooking);
  const isFlaggedProvisional =
    !booking.parentBookingId &&
    booking.status === "PENDING" &&
    booking.cancelIfGuestsBumped &&
    booking.hasNonMembers;

  // Issue #777: a provisional/on-hold PENDING booking shows no pay control,
  // which left testers unsure whether one should exist. The "Save Payment
  // Method" card below already explains the save-card flow, so the on-hold
  // explanation is only needed when that card is not showing.
  const showSavePaymentMethodCard =
    !isDeleted &&
    !internetBankingPayment &&
    booking.status === "PENDING" &&
    (!booking.payment || !booking.payment.stripeSetupIntentId);
  // Suppress when a more specific provisional banner already explains the
  // on-hold/no-charge state (the split-booking child and the bumped-guest
  // flagged-provisional notices both render near the top of the page).
  const showPaymentOnHoldNotice =
    !isDeleted &&
    booking.status === "PENDING" &&
    !showSavePaymentMethodCard &&
    !isProvisionalChild &&
    !isFlaggedProvisional;

  // Issue #778: surface auto-applied member credit (display only). Credit nets
  // off the booking price, so amount due = finalPriceCents - creditAppliedCents.
  const creditAppliedCents = booking.payment?.creditAppliedCents ?? 0;
  const showCreditApplied =
    creditAppliedCents > 0 &&
    isPaymentOwedBookingStatus(booking.status) &&
    booking.payment?.status !== "SUCCEEDED";
  const amountDueAfterCreditCents = Math.max(
    booking.finalPriceCents - creditAppliedCents,
    0
  );

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Booking Details</h1>
        <div className="flex items-center gap-2">
          {!isDeleted && session.user.role === "ADMIN" ? (
            <CopyBookingButton
              bookingId={booking.id}
              sourceCheckIn={editorData.checkIn}
              sourceCheckOut={editorData.checkOut}
              minCheckIn={editorData.editPolicy.today}
            />
          ) : null}
          <Link href={backHref}>
            <Button variant="outline">Back to Bookings</Button>
          </Link>
        </div>
      </div>

      {isDeleted ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          <p className="font-medium">Deleted cancelled booking</p>
          <p>
            Deleted {booking.deletedAt?.toLocaleString("en-NZ")}
            {booking.deletedBy
              ? ` by ${booking.deletedBy.firstName} ${booking.deletedBy.lastName}`
              : ""}
            .
          </p>
          {booking.deletedReason ? (
            <p className="mt-1">Reason: {booking.deletedReason}</p>
          ) : null}
        </div>
      ) : null}

      {NARRATIVE_BANNER_STATES.has(bookingNarrative.state) ? (
        <div
          className={`space-y-1 rounded-md border px-4 py-3 text-sm ${
            narrativeBannerClasses[bookingNarrative.state] ??
            "border-slate-200 bg-slate-50 text-slate-900"
          }`}
        >
          <p className="font-medium">{bookingNarrative.headline}</p>
          <p>{bookingNarrative.message}</p>
          <p className="opacity-80">{bookingNarrative.nextStep}</p>
        </div>
      ) : null}

      {hasProvisionalChildren ? (
        <div className="space-y-1 rounded-md border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
          <p className="font-medium">
            {provisionalChildGuestCount} non-member guest
            {provisionalChildGuestCount === 1 ? "" : "s"} held provisionally
          </p>
          <p>
            Your own place is confirmed once you pay for this booking. Your
            non-member guests are held in a linked provisional booking —{" "}
            <strong>no beds are reserved for them</strong> until they are
            confirmed and paid for closer to your stay. We&apos;ll be in touch
            before then.
          </p>
        </div>
      ) : null}

      {isProvisionalChild ? (
        <div className="space-y-1 rounded-md border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
          <p className="font-medium">Provisional non-member guests</p>
          <p>
            This is the non-member portion of your party, linked to your{" "}
            <Link
              href={`/bookings/${booking.parentBooking!.id}`}
              className="font-medium underline"
            >
              member booking
            </Link>
            . <strong>No beds are held</strong> for these guests until they are
            confirmed and paid for — nothing has been charged yet.
          </p>
        </div>
      ) : null}

      {isFlaggedProvisional ? (
        <div className="space-y-1 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-medium">Provisional booking — no beds held yet</p>
          <p>
            You asked us to only confirm this booking if your guests can come,
            so <strong>no beds are held and nothing has been charged</strong>.
            We&apos;ll confirm the whole party — you and your guests — once your
            guests are confirmed and paid for closer to your stay.
          </p>
        </div>
      ) : null}

      <BookingEditor booking={editorData} canModify={canModify} />

      {booking.createdBy && (
        <div className="rounded-md bg-slate-50 border border-slate-200 px-4 py-3 text-sm text-slate-600">
          Created by <strong>{booking.createdBy.firstName} {booking.createdBy.lastName}</strong> (admin) on behalf of this member
        </div>
      )}

      {booking.requiresAdminReview && (
        <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p>
            <strong>
              {booking.adminReviewStatus === "PENDING"
                ? "Awaiting admin review."
                : booking.adminReviewStatus === "APPROVED"
                  ? "Approved by admin."
                  : booking.adminReviewStatus === "REJECTED"
                    ? "Declined by admin."
                    : "Admin review required."}
            </strong>{" "}
            {booking.adminReviewReason ?? "This booking needs manual review by an admin."}
          </p>
          {booking.adminReviewStatus === "PENDING" && (
            <p>
              Payment cannot be taken until an admin approves. You can amend the
              booking to include an adult guest if you would like to clear this flag.
            </p>
          )}
          {booking.memberReviewJustification && (
            <p>
              <span className="font-medium">Your reason:</span>{" "}
              {booking.memberReviewJustification}
            </p>
          )}
          {booking.adminReviewNotes && booking.adminReviewStatus !== "PENDING" && (
            <p>
              <span className="font-medium">Admin note:</span> {booking.adminReviewNotes}
            </p>
          )}
        </div>
      )}

      {booking.changeRequests.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Change Requests</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {booking.changeRequests.map((request) => {
              const requested = request.requestedChanges as {
                requested?: { summary?: string | null };
              };
              return (
                <div key={request.id} className="rounded-md border p-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-medium">
                      {requested.requested?.summary ?? "Booking change request"}
                    </p>
                    <Badge variant={request.status === "REQUESTED" ? "outline" : "secondary"}>
                      {request.status}
                    </Badge>
                  </div>
                  <p className="mt-1 text-slate-500">
                    Submitted{" "}
                    {request.createdAt.toLocaleDateString("en-NZ", {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                  </p>
                  {request.reason ? (
                    <p className="mt-2 text-slate-700">{request.reason}</p>
                  ) : null}
                  {request.adminNotes ? (
                    <p className="mt-2 text-slate-600">{request.adminNotes}</p>
                  ) : null}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {showArrivalTime && (
        <Card>
          <CardHeader>
            <CardTitle>Expected Arrival Time</CardTitle>
          </CardHeader>
          <CardContent>
            <ArrivalTimeEditor
              bookingId={booking.id}
              initialTime={booking.expectedArrivalTime}
              canEdit={editPolicy.mode === "future"}
            />
          </CardContent>
        </Card>
      )}

      {showRequestedRoom && (
        <Card>
          <CardHeader>
            <CardTitle>Room Request</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {canEditRequestedRoom && session.user.role !== "ADMIN" ? (
              <p className="text-sm text-slate-600">
                Let us know if you&apos;d prefer a particular room. This is a
                request, not a guaranteed allocation. The lodge confirms beds
                closer to your stay.
              </p>
            ) : null}
            <RequestedRoomEditor
              bookingId={booking.id}
              initialRoom={booking.requestedRoom}
              canEdit={canEditRequestedRoom}
              endpoint={
                session.user.role === "ADMIN"
                  ? undefined
                  : `/api/bookings/${booking.id}/requested-room`
              }
              lockedNote={
                bedAllocationLocked && session.user.role !== "ADMIN"
                  ? "Your beds have been allocated by the lodge and can no longer be changed here."
                  : undefined
              }
            />
          </CardContent>
        </Card>
      )}

      {memberArrivalInstructions ? (
        <Card>
          <CardHeader>
            <CardTitle>How to Get to the Lodge</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-slate-700">
            <p className="whitespace-pre-wrap">
              {memberArrivalInstructions.lodgeTravelNote}
            </p>
            {memberArrivalInstructions.doorCode ? (
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Door code
                </p>
                <p className="mt-1 text-lg font-semibold tracking-wide text-slate-950">
                  {memberArrivalInstructions.doorCode}
                </p>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {/* Admin: force-confirm non-member guests still on hold (issue #708) */}
      {!isDeleted &&
        session.user.role === "ADMIN" &&
        booking.status === "PENDING" &&
        booking.hasNonMembers &&
        booking.nonMemberHoldUntil && (
          <ConfirmPendingGuestsButton
            bookingId={booking.id}
            hasSavedPaymentMethod={Boolean(
              booking.payment?.stripePaymentMethodId &&
                booking.payment?.stripeCustomerId
            )}
          />
        )}

      {/* Draft booking: $0 confirm or payment to complete */}
      {!isDeleted && isDraft && booking.finalPriceCents === 0 && (
        <ConfirmDraftButton bookingId={booking.id} />
      )}

      {/* Draft booking with non-zero price: show payment section to complete */}
      {!isDeleted && isDraft && booking.finalPriceCents > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Complete Booking</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-gray-600 mb-4">
              This is a saved draft. Review the details above, then confirm when
              you&apos;re ready to pay and finalise the booking.
            </p>
            <BookingPaymentSection
              bookingId={booking.id}
              amountCents={booking.finalPriceCents}
              paymentMode={getBookingPaymentMode(booking.status)}
              returnUrl={`${process.env.NEXTAUTH_URL || "http://localhost:3000"}/bookings/${booking.id}`}
              showOnMount={false}
              gateDescription="Draft bookings stay editable until you explicitly continue to payment. Payment is still collected immediately once you choose to complete the booking."
              gateCtaLabel="Confirm & Continue to Payment"
            />
          </CardContent>
        </Card>
      )}

      {/* Waitlisted booking: show position */}
      {isWaitlisted && (
        <Card className="border-purple-200 bg-purple-50">
          <CardHeader>
            <CardTitle className="text-purple-900">On the Waitlist</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {booking.waitlistPosition && (
              <p className="text-sm font-medium text-purple-800">
                Position: #{booking.waitlistPosition}
              </p>
            )}
            <p className="text-sm text-purple-700">
              We&apos;ll email you when a spot opens up. You&apos;ll have 48 hours to confirm your booking.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Waitlist offered: show confirm button with countdown */}
      {isWaitlistOffered && booking.waitlistOfferExpiresAt && (
        <WaitlistOfferCard
          bookingId={booking.id}
          expiresAt={booking.waitlistOfferExpiresAt.toISOString()}
          finalPriceCents={booking.finalPriceCents}
        />
      )}

      {!isDeleted &&
        internetBankingPayment &&
        isPaymentOwedBookingStatus(booking.status) &&
        internetBankingPayment.status !== "SUCCEEDED" && (
          <Card className="border-amber-200 bg-amber-50">
            <CardHeader>
              <CardTitle className="text-amber-950">Internet Banking Payment</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-amber-950">
              <p>
                Your Xero invoice will be emailed to you. This booking stays
                Payment Pending until Xero reconciliation confirms the invoice
                has been paid.
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <span className="text-amber-800">Amount due:</span>{" "}
                  <span className="font-medium">
                    {formatCents(internetBankingPayment.amountCents)}
                  </span>
                </div>
                {internetBankingPayment.reference ? (
                  <div>
                    <span className="text-amber-800">Reference:</span>{" "}
                    <span className="font-medium">{internetBankingPayment.reference}</span>
                  </div>
                ) : null}
                {internetBankingPayment.xeroInvoiceNumber ? (
                  <div>
                    <span className="text-amber-800">Xero invoice:</span>{" "}
                    <span className="font-medium">
                      {internetBankingPayment.xeroInvoiceNumber}
                    </span>
                  </div>
                ) : internetBankingPayment.xeroInvoiceId ? (
                  <div>
                    <span className="text-amber-800">Xero invoice:</span>{" "}
                    <span className="font-medium">
                      {internetBankingPayment.xeroInvoiceId.slice(0, 8)}
                    </span>
                  </div>
                ) : null}
              </div>
            </CardContent>
          </Card>
        )}

      {/* Provisional/on-hold booking: explain why no payment is collected yet
          (issue #777). */}
      {showPaymentOnHoldNotice && (
        <Card className="border-sky-200 bg-sky-50">
          <CardHeader>
            <CardTitle className="text-sky-900">Payment on hold</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-sky-900">
              This is a provisional booking. We&apos;ll confirm your place and
              collect payment once your guests are confirmed, closer to your
              stay.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Show payment form if payment hasn't been completed */}
      {(!isDeleted && !internetBankingPayment && isPaymentOwedBookingStatus(booking.status) && (!booking.payment || booking.payment.status !== "SUCCEEDED")) && (
        <Card>
          <CardHeader>
            <CardTitle>Complete Payment</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-gray-600 mb-4">
              Payment is required to secure this booking. Availability may change until payment succeeds.
            </p>
            {showCreditApplied && (
              <div className="mb-4 space-y-1 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
                <div className="flex items-center justify-between">
                  <span>Booking total</span>
                  <span>{formatCents(booking.finalPriceCents)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Credit applied</span>
                  <span>-{formatCents(creditAppliedCents)}</span>
                </div>
                <div className="flex items-center justify-between font-medium">
                  <span>Amount due</span>
                  <span>{formatCents(amountDueAfterCreditCents)}</span>
                </div>
              </div>
            )}
            <BookingPaymentSection
              bookingId={booking.id}
              amountCents={
                showCreditApplied
                  ? amountDueAfterCreditCents
                  : booking.finalPriceCents
              }
              paymentMode={getBookingPaymentMode(booking.status)}
              returnUrl={`${process.env.NEXTAUTH_URL || "http://localhost:3000"}/bookings/${booking.id}`}
            />
          </CardContent>
        </Card>
      )}

      {showSavePaymentMethodCard && (
        <Card>
          <CardHeader>
            <CardTitle>Save Payment Method</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-gray-600 mb-4">
              Please save a payment method. Your card will be charged when your booking is confirmed
              closer to check-in.
            </p>
            <BookingPaymentSection
              bookingId={booking.id}
              amountCents={booking.finalPriceCents}
              paymentMode={getBookingPaymentMode(booking.status)}
              returnUrl={`${process.env.NEXTAUTH_URL || "http://localhost:3000"}/bookings/${booking.id}`}
            />
          </CardContent>
        </Card>
      )}

      {/* Additional payment required after a modification that increased the price */}
      {booking.payment &&
        !isDeleted &&
        booking.payment.additionalAmountCents > 0 &&
        booking.payment.additionalPaymentStatus !== "SUCCEEDED" && (
          <AdditionalPaymentCard
            bookingId={booking.id}
            additionalAmountCents={booking.payment.additionalAmountCents}
          />
        )}

      {canCancel && (
        <CancelBookingButton bookingId={booking.id} />
      )}

      {canDeleteDraft ? (
        <DeleteBookingButton
          bookingId={booking.id}
          mode="draft"
          returnHref={backHref}
        />
      ) : null}

      {canSoftDeleteCancelled ? (
        <DeleteBookingButton
          bookingId={booking.id}
          mode="cancelled"
          returnHref={backHref}
        />
      ) : null}

      {!isDeleted &&
        booking.status === "CANCELLED" &&
        booking.payment &&
        booking.payment.status !== "REFUNDED" &&
        maxRefundableCents > 0 && (
          <RefundAppealButton
            bookingId={booking.id}
            maxRefundableCents={maxRefundableCents}
          />
        )}

      {booking.status === "CANCELLED" && (
        <Card>
          <CardHeader>
            <CardTitle>Cancellation Outcome</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Badge
                className={
                  paymentDisplay
                    ? paymentStatusClass(paymentDisplay.toneStatus)
                    : "bg-slate-100 text-slate-700"
                }
              >
                {paymentDisplay?.label ?? "Cancelled Before Payment"}
              </Badge>
              <p className="text-sm text-slate-600">
                {paymentDisplay?.detail ??
                  "No original payment was captured for this booking, so nothing needed to be returned."}
              </p>
            </div>

            <div className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <span className="text-slate-500">Original payment:</span>{" "}
                {originalPaymentCaptured && booking.payment
                  ? formatCents(booking.payment.amountCents)
                  : "No original payment captured"}
              </div>

              {originalPaymentCaptured && cancellationSettlement && (
                <>
                  <div>
                    <span className="text-slate-500">
                      Returned to original payment method:
                    </span>{" "}
                    {formatCents(
                      cancellationSettlement.refundToOriginalMethodCents
                    )}
                  </div>

                  <div>
                    <span className="text-slate-500">Held as account credit:</span>{" "}
                    {formatCents(cancellationSettlement.accountCreditCents)}
                  </div>

                  <div>
                    <span className="text-slate-500">
                      Non-refundable amount retained:
                    </span>{" "}
                    {formatCents(retainedAfterCancellationCents)}
                  </div>

                  {cancellationSettlement.restoredAppliedCreditCents > 0 && (
                    <div>
                      <span className="text-slate-500">
                        Previously applied credit restored:
                      </span>{" "}
                      {formatCents(
                        cancellationSettlement.restoredAppliedCreditCents
                      )}
                    </div>
                  )}

                  {booking.payment?.changeFeeCents
                    ? (
                    <div>
                      <span className="text-slate-500">
                        Included non-refundable change fees:
                      </span>{" "}
                      {formatCents(booking.payment.changeFeeCents)}
                    </div>
                      )
                    : null}
                </>
              )}

              {latestRefundAppeal && (
                <div>
                  <span className="text-slate-500">Latest refund appeal:</span>{" "}
                  <Badge
                    variant={
                      latestRefundAppeal.status === "PENDING"
                        ? "outline"
                        : latestRefundAppeal.status === "APPROVED"
                          ? "default"
                          : "destructive"
                    }
                    className="align-middle"
                  >
                    {latestRefundAppeal.status}
                  </Badge>
                  {latestRefundAppeal.requestedAmountCents ? (
                    <span className="ml-2 text-slate-600">
                      Requested {formatCents(latestRefundAppeal.requestedAmountCents)}
                    </span>
                  ) : null}
                  {latestRefundAppeal.approvedAmountCents ? (
                    <span className="ml-2 text-slate-600">
                      Approved {formatCents(latestRefundAppeal.approvedAmountCents)}
                    </span>
                  ) : null}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Notes</CardTitle>
        </CardHeader>
        <CardContent>
          <BookingNotesEditor
            bookingId={booking.id}
            initialNotes={booking.notes ?? ""}
            canEdit={canCancel}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Transaction History</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="divide-y">
            {bookingHistory.map((item) => (
              <div
                key={item.id}
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant="outline"
                      className={historyToneClasses[item.tone]}
                    >
                      {item.category}
                    </Badge>
                    <span className="text-sm font-medium text-slate-900">
                      {item.title}
                    </span>
                    <span className="text-xs text-slate-500">
                      {item.occurredAt.toLocaleDateString("en-NZ", {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                  {item.detail ? (
                    <p className="text-sm text-slate-600">{item.detail}</p>
                  ) : null}
                </div>
                {item.amountDisplay ? (
                  <span
                    className={`text-sm font-medium ${
                      item.tone === "danger"
                        ? "text-rose-700"
                        : item.tone === "success"
                          ? "text-emerald-700"
                          : item.tone === "warning"
                            ? "text-amber-700"
                            : "text-slate-700"
                    }`}
                  >
                    {item.amountDisplay}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
