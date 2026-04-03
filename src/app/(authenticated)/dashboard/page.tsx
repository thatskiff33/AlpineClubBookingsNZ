import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCents } from "@/lib/utils";

export default async function DashboardPage() {
  const session = await auth();
  if (!session) return null;

  const upcomingBookings = await prisma.booking.findMany({
    where: {
      memberId: session.user.id,
      checkOut: { gte: new Date() },
      status: { in: ["CONFIRMED", "PENDING"] },
    },
    include: { guests: true },
    orderBy: { checkIn: "asc" },
    take: 5,
  });

  const statusColor = (status: string) => {
    switch (status) {
      case "CONFIRMED": return "success" as const;
      case "PENDING": return "warning" as const;
      case "CANCELLED": return "destructive" as const;
      default: return "secondary" as const;
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Welcome, {session.user.name?.split(" ")[0]}</h1>
        <p className="text-gray-600 mt-1">Manage your lodge bookings</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Link href="/book">
          <Card className="cursor-pointer transition-shadow hover:shadow-md">
            <CardHeader>
              <CardTitle className="text-lg">Book a Stay</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-gray-600">Check availability and book beds at the lodge</p>
            </CardContent>
          </Card>
        </Link>
        <Link href="/bookings">
          <Card className="cursor-pointer transition-shadow hover:shadow-md">
            <CardHeader>
              <CardTitle className="text-lg">My Bookings</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-gray-600">View and manage your bookings</p>
            </CardContent>
          </Card>
        </Link>
      </div>

      {upcomingBookings.length > 0 && (
        <div>
          <h2 className="text-xl font-semibold mb-4">Upcoming Stays</h2>
          <div className="space-y-3">
            {upcomingBookings.map((booking) => (
              <Link key={booking.id} href={`/bookings/${booking.id}`}>
                <Card className="cursor-pointer transition-shadow hover:shadow-md">
                  <CardContent className="flex items-center justify-between p-4">
                    <div>
                      <p className="font-medium">
                        {new Date(booking.checkIn).toLocaleDateString("en-NZ")} -{" "}
                        {new Date(booking.checkOut).toLocaleDateString("en-NZ")}
                      </p>
                      <p className="text-sm text-gray-600">
                        {booking.guests.length} guest{booking.guests.length !== 1 ? "s" : ""} &middot;{" "}
                        {formatCents(booking.finalPriceCents)}
                      </p>
                    </div>
                    <Badge variant={statusColor(booking.status)}>{booking.status}</Badge>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </div>
      )}

      {upcomingBookings.length === 0 && (
        <Card>
          <CardContent className="p-6 text-center">
            <p className="text-gray-600 mb-4">No upcoming bookings</p>
            <Link href="/book">
              <Button>Book a Stay</Button>
            </Link>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
