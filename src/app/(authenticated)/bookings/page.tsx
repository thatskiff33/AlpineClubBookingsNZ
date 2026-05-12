import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCents } from "@/lib/utils";
import { bookingStatusClass, bookingStatusLabel } from "@/lib/status-colors";
import { buildHrefWithReturnTo } from "@/lib/internal-return-path";

export default async function MyBookingsPage() {
  const session = await auth();
  if (!session) return null;

  const bookings = await prisma.booking.findMany({
    where: { memberId: session.user.id },
    include: { guests: true },
    orderBy: { checkIn: "desc" },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">My Bookings</h1>
        <Link href="/book">
          <Button>New Booking</Button>
        </Link>
      </div>

      {bookings.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-center">
            <p className="text-gray-600 mb-4">You haven&apos;t made any bookings yet.</p>
            <Link href="/book">
              <Button>Book a Stay</Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {bookings.map((booking) => (
            <Link key={booking.id} href={buildHrefWithReturnTo(`/bookings/${booking.id}`, "/bookings")}>
              <Card className="cursor-pointer transition-shadow hover:shadow-md mb-3">
                <CardContent className="flex items-center justify-between p-4">
                  <div className="space-y-1">
                    <p className="font-medium">
                      {new Date(booking.checkIn).toLocaleDateString("en-NZ", {
                        weekday: "short", day: "numeric", month: "short", year: "numeric",
                      })}{" "}
                      -{" "}
                      {new Date(booking.checkOut).toLocaleDateString("en-NZ", {
                        weekday: "short", day: "numeric", month: "short", year: "numeric",
                      })}
                    </p>
                    <p className="text-sm text-gray-600">
                      {booking.guests.length} guest{booking.guests.length !== 1 ? "s" : ""} &middot;{" "}
                      {formatCents(booking.finalPriceCents)}
                    </p>
                  </div>
                  <Badge variant="secondary" className={bookingStatusClass(booking.status)}>
                    {bookingStatusLabel(booking.status)}
                  </Badge>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
