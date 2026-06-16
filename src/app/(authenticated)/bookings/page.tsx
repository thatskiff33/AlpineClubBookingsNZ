import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MyBookingsList, type MyBookingItem } from "./_components/my-bookings-list";

export default async function MyBookingsPage() {
  const session = await auth();
  if (!session) return null;

  const bookings = await prisma.booking.findMany({
    where: { memberId: session.user.id, deletedAt: null },
    include: { guests: true },
    // Newest start date first, with a stable createdAt tiebreaker (#771).
    orderBy: [{ checkIn: "desc" }, { createdAt: "desc" }],
  });

  // Split-booking grouping (#738): a mixed party is a member booking plus a
  // linked provisional non-member booking. Label both so a family reads as one.
  const memberBookingIdsWithLinkedGuests = new Set(
    bookings
      .map((booking) => booking.parentBookingId)
      .filter((id): id is string => Boolean(id)),
  );

  const items: MyBookingItem[] = bookings.map((booking) => ({
    id: booking.id,
    checkIn: booking.checkIn.toISOString(),
    checkOut: booking.checkOut.toISOString(),
    guestCount: booking.guests.length,
    finalPriceCents: booking.finalPriceCents,
    status: booking.status,
    linkLabel: booking.parentBookingId
      ? "provisional-child"
      : memberBookingIdsWithLinkedGuests.has(booking.id)
        ? "linked-parent"
        : null,
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">My Bookings</h1>
        <Link href="/book">
          <Button>New Booking</Button>
        </Link>
      </div>

      {items.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-center">
            <p className="text-gray-600 mb-4">You haven&apos;t made any bookings yet.</p>
            <Link href="/book">
              <Button>Book a Stay</Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <MyBookingsList bookings={items} />
      )}
    </div>
  );
}
