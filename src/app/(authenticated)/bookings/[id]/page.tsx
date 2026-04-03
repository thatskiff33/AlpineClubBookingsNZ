import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { notFound, redirect } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { formatCents } from "@/lib/utils";
import { CancelBookingButton } from "@/components/cancel-booking-button";

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
    },
  });

  if (!booking) notFound();
  if (booking.memberId !== session.user.id && session.user.role !== "ADMIN") {
    redirect("/bookings");
  }

  const statusColor = (status: string) => {
    switch (status) {
      case "CONFIRMED": return "success" as const;
      case "PENDING": return "warning" as const;
      case "CANCELLED": case "BUMPED": return "destructive" as const;
      default: return "secondary" as const;
    }
  };

  const nights = Math.ceil(
    (new Date(booking.checkOut).getTime() - new Date(booking.checkIn).getTime()) /
      (1000 * 60 * 60 * 24)
  );

  const canCancel = booking.status === "CONFIRMED" || booking.status === "PENDING";

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Booking Details</h1>
        <Link href="/bookings">
          <Button variant="outline">Back to Bookings</Button>
        </Link>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Stay Details</CardTitle>
            <Badge variant={statusColor(booking.status)}>{booking.status}</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-sm text-gray-500">Check-in</p>
              <p className="font-medium">
                {new Date(booking.checkIn).toLocaleDateString("en-NZ", {
                  weekday: "long", day: "numeric", month: "long", year: "numeric",
                })}
              </p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Check-out</p>
              <p className="font-medium">
                {new Date(booking.checkOut).toLocaleDateString("en-NZ", {
                  weekday: "long", day: "numeric", month: "long", year: "numeric",
                })}
              </p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Nights</p>
              <p className="font-medium">{nights}</p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Guests</p>
              <p className="font-medium">{booking.guests.length}</p>
            </div>
          </div>

          {booking.status === "PENDING" && booking.nonMemberHoldUntil && (
            <div className="rounded-md bg-yellow-50 p-3 text-sm text-yellow-800">
              This booking includes non-members. It will be auto-confirmed on{" "}
              {new Date(booking.nonMemberHoldUntil).toLocaleDateString("en-NZ")} (7 days before check-in),
              subject to availability. Members have priority.
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Guests</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="divide-y">
            {booking.guests.map((guest) => (
              <div key={guest.id} className="flex items-center justify-between py-3">
                <div>
                  <p className="font-medium">{guest.firstName} {guest.lastName}</p>
                  <p className="text-sm text-gray-500">
                    {guest.ageTier} &middot; {guest.isMember ? "Member" : "Non-member"}
                  </p>
                </div>
                <p className="font-medium">{formatCents(guest.priceCents)}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Payment</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex justify-between">
            <span>Subtotal</span>
            <span>{formatCents(booking.totalPriceCents)}</span>
          </div>
          {booking.discountCents > 0 && (
            <div className="flex justify-between text-green-600">
              <span>Discount</span>
              <span>-{formatCents(booking.discountCents)}</span>
            </div>
          )}
          <div className="flex justify-between border-t pt-2 font-bold">
            <span>Total</span>
            <span>{formatCents(booking.finalPriceCents)}</span>
          </div>
        </CardContent>
      </Card>

      {canCancel && (
        <CancelBookingButton bookingId={booking.id} />
      )}

      {booking.notes && (
        <Card>
          <CardHeader>
            <CardTitle>Notes</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-gray-600">{booking.notes}</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
