import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import Link from "next/link";

export default async function AdminDashboardPage() {
  const [totalMembers, activeBookings, upcomingBookings, totalRevenue] =
    await Promise.all([
      prisma.member.count({ where: { active: true } }),
      prisma.booking.count({
        where: { status: { in: ["CONFIRMED", "PENDING"] } },
      }),
      prisma.booking.count({
        where: {
          checkIn: { gte: new Date() },
          status: { in: ["CONFIRMED", "PENDING"] },
        },
      }),
      prisma.booking.aggregate({
        _sum: { finalPriceCents: true },
        where: { status: { in: ["CONFIRMED", "COMPLETED"] } },
      }),
    ]);

  const stats = [
    { label: "Active Members", value: totalMembers, href: "/admin/members" },
    { label: "Active Bookings", value: activeBookings, href: "/admin/bookings" },
    { label: "Upcoming Stays", value: upcomingBookings, href: "/admin/bookings" },
    {
      label: "Total Revenue",
      value: `$${((totalRevenue._sum.finalPriceCents || 0) / 100).toFixed(2)}`,
      href: "/admin/bookings",
    },
  ];

  return (
    <div className="space-y-8">
      <h1 className="text-3xl font-bold">Admin Dashboard</h1>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <Link key={stat.label} href={stat.href}>
            <Card className="cursor-pointer transition-shadow hover:shadow-md">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-gray-600">
                  {stat.label}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{stat.value}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
