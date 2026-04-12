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
import { ArrivalTimeEditor } from "@/components/arrival-time-editor";
import { WaitlistOfferCard } from "@/components/waitlist-offer-card";
import { canModifyBookingStatus } from "@/lib/booking-modify-permissions";
import { RefundAppealButton } from "@/components/refund-appeal-button";

export default async function BookingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  if (!session) redirect("/login");

  const booking = await prisma.booking.findUnique({
    where: { id },
    include: {
      guests: true,
      payment: true,
      promoRedemption: {
        include: {
          promoCode: { select: { code: true, type: true, description: true } },
        },
      },
      modifications: {
        orderBy: { createdAt: "desc" },
      },
      createdBy: {
        select: { firstName: true, lastName: true },
      },
    },
  });

  if (!booking) notFound();
  if (booking.memberId !== session.user.id && session.user.role !== "ADMIN") {
    redirect("/bookings");
  }

  const nights = Math.ceil(
    (new Date(booking.checkOut).getTime() - new Date(booking.checkIn).getTime()) /
      (1000 * 60 * 60 * 24)
  );
  const currentTime = new Date().getTime();
  const checkInDaysAway = Math.ceil(
    (new Date(booking.checkIn).getTime() - currentTime) / (1000 * 60 * 60 * 24)
  );

  const isDraft = booking.status === "DRAFT";
  const isWaitlisted = booking.status === "WAITLISTED";
  const isWaitlistOffered = booking.status === "WAITLIST_OFFERED";
  const canCancel = ["CONFIRMED", "PAID", "PENDING", "WAITLISTED", "WAITLIST_OFFERED"].includes(booking.status);
  const isFutureCheckIn = new Date(booking.checkIn) > new Date();
  const canModify =
    canModifyBookingStatus(booking.status, session.user.role) && isFutureCheckIn;

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
      priceCents: g.priceCents,
    })),
    bookingMemberId: booking.memberId,
    viewerRole: session.user.role,
    totalPriceCents: booking.totalPriceCents,
    discountCents: booking.discountCents,
    finalPriceCents: booking.finalPriceCents,
    promo: booking.promoRedemption?.promoCode
      ? {
          code: booking.promoRedemption.promoCode.code,
          type: booking.promoRedemption.promoCode.type,
          description: booking.promoRedemption.promoCode.description,
        }
      : null,
    hasNonMembers: booking.hasNonMembers,
    nonMemberHoldUntil: booking.nonMemberHoldUntil?.toISOString() ?? null,
  };

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Booking Details</h1>
        <Link href="/bookings">
          <Button variant="outline">Back to Bookings</Button>
        </Link>
      </div>

      <BookingEditor booking={editorData} canModify={canModify} />

      {booking.createdBy && (
        <div className="rounded-md bg-slate-50 border border-slate-200 px-4 py-3 text-sm text-slate-600">
          Created by <strong>{booking.createdBy.firstName} {booking.createdBy.lastName}</strong> (admin) on behalf of this member
        </div>
      )}

      {/* Expected Arrival Time */}
      <Card>
        <CardHeader>
          <CardTitle>Expected Arrival Time</CardTitle>
        </CardHeader>
        <CardContent>
          <ArrivalTimeEditor
            bookingId={booking.id}
            initialTime={booking.expectedArrivalTime}
            canEdit={isFutureCheckIn}
          />
        </CardContent>
      </Card>

      {/* Draft booking: $0 confirm or payment to complete */}
      {isDraft && booking.finalPriceCents === 0 && (
        <ConfirmDraftButton bookingId={booking.id} />
      )}

      {/* Draft booking with non-zero price: show payment section to complete */}
      {isDraft && booking.finalPriceCents > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Complete Booking</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-gray-600 mb-4">
              This is a saved draft. Complete your booking by making payment below.
            </p>
            <BookingPaymentSection
              bookingId={booking.id}
              amountCents={booking.finalPriceCents}
              hasNonMembers={booking.hasNonMembers}
              checkInDaysAway={checkInDaysAway}
              returnUrl={`${process.env.NEXTAUTH_URL || "http://localhost:3000"}/bookings/${booking.id}`}
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

      {/* Show payment form if payment hasn't been completed */}
      {(booking.status === "CONFIRMED" && (!booking.payment || booking.payment.status !== "SUCCEEDED")) && (
        <Card>
          <CardHeader>
            <CardTitle>Complete Payment</CardTitle>
          </CardHeader>
          <CardContent>
            <BookingPaymentSection
              bookingId={booking.id}
              amountCents={booking.finalPriceCents}
              hasNonMembers={booking.hasNonMembers}
              checkInDaysAway={checkInDaysAway}
              returnUrl={`${process.env.NEXTAUTH_URL || "http://localhost:3000"}/bookings/${booking.id}`}
            />
          </CardContent>
        </Card>
      )}

      {(booking.status === "PENDING" && (!booking.payment || !booking.payment.stripeSetupIntentId)) && (
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
              hasNonMembers={booking.hasNonMembers}
              checkInDaysAway={checkInDaysAway}
              returnUrl={`${process.env.NEXTAUTH_URL || "http://localhost:3000"}/bookings/${booking.id}`}
            />
          </CardContent>
        </Card>
      )}

      {/* Additional payment required after a modification that increased the price */}
      {booking.payment &&
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

      {booking.status === "CANCELLED" &&
        booking.payment &&
        booking.payment.status !== "REFUNDED" &&
        booking.payment.amountCents - booking.payment.refundedAmountCents > 0 && (
          <RefundAppealButton
            bookingId={booking.id}
            maxRefundableCents={
              booking.payment.amountCents - booking.payment.refundedAmountCents
            }
          />
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

      {booking.modifications.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Modification History</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="divide-y">
              {booking.modifications.map((mod) => {
                const prev = mod.previousData as Record<string, unknown>;
                const next = mod.newData as Record<string, unknown>;
                const typeLabels: Record<string, string> = {
                  DATE_CHANGE: "Dates Changed",
                  GUEST_ADD: "Guests Added",
                  GUEST_REMOVE: "Guest Removed",
                  EXTEND_STAY: "Stay Extended",
                  BATCH_MODIFY: "Booking Modified",
                };
                return (
                  <div key={mod.id} className="py-3 space-y-1">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline">
                          {typeLabels[mod.modificationType] || mod.modificationType}
                        </Badge>
                        <span className="text-sm text-gray-500">
                          {new Date(mod.createdAt).toLocaleDateString("en-NZ", {
                            day: "numeric",
                            month: "short",
                            year: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </div>
                      {mod.priceDiffCents !== 0 && (
                        <span
                          className={`text-sm font-medium ${
                            mod.priceDiffCents > 0
                              ? "text-red-600"
                              : "text-green-600"
                          }`}
                        >
                          {mod.priceDiffCents > 0 ? "+" : ""}
                          {formatCents(mod.priceDiffCents)}
                        </span>
                      )}
                    </div>
                    <div className="text-sm text-gray-600">
                      {mod.modificationType === "DATE_CHANGE" && (
                        <p>
                          {String(prev.checkIn)} &rarr; {String(next.checkIn)},{" "}
                          {String(prev.checkOut)} &rarr; {String(next.checkOut)}
                        </p>
                      )}
                      {mod.modificationType === "GUEST_ADD" && (
                        <p>
                          {String(prev.guestCount)} &rarr; {String(next.guestCount)} guests
                        </p>
                      )}
                      {mod.modificationType === "GUEST_REMOVE" && (
                        <p>
                          Removed{" "}
                          {(prev.removedGuest as { firstName: string; lastName: string })?.firstName}{" "}
                          {(prev.removedGuest as { firstName: string; lastName: string })?.lastName}
                          {" "}&middot;{" "}
                          {String(prev.guestCount)} &rarr; {String(next.guestCount)} guests
                        </p>
                      )}
                      {mod.modificationType === "BATCH_MODIFY" && (
                        <p>
                          {prev.checkIn !== next.checkIn || prev.checkOut !== next.checkOut
                            ? `${String(prev.checkIn)}-${String(prev.checkOut)} → ${String(next.checkIn)}-${String(next.checkOut)}`
                            : ""}
                          {prev.guestCount !== next.guestCount
                            ? `${prev.checkIn !== next.checkIn ? " · " : ""}${String(prev.guestCount)} → ${String(next.guestCount)} guests`
                            : ""}
                        </p>
                      )}
                    </div>
                    {mod.changeFeeCents > 0 && (
                      <p className="text-xs text-amber-600">
                        Change fee: {formatCents(mod.changeFeeCents)}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
