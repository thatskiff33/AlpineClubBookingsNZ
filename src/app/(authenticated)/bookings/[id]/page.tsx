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

  const canCancel = ["CONFIRMED", "PAID", "PENDING"].includes(booking.status);
  const isFutureCheckIn = new Date(booking.checkIn) > new Date();
  const canModify = canCancel && isFutureCheckIn;

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
      priceCents: g.priceCents,
    })),
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
              checkInDaysAway={Math.ceil(
                (new Date(booking.checkIn).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
              )}
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
              checkInDaysAway={Math.ceil(
                (new Date(booking.checkIn).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
              )}
              returnUrl={`${process.env.NEXTAUTH_URL || "http://localhost:3000"}/bookings/${booking.id}`}
            />
          </CardContent>
        </Card>
      )}

      {canCancel && (
        <CancelBookingButton bookingId={booking.id} />
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
