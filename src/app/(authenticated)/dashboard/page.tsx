import Link from "next/link";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CalendarDays, BedDouble, PlusCircle, Mountain } from "lucide-react";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const firstName = session.user.name?.split(" ")[0] ?? "Member";

  return (
    <div className="space-y-8">
      {/* Welcome header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            Welcome back, {firstName}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Tokoroa Alpine Club — Member Portal
          </p>
        </div>
        <Button asChild>
          <Link href="/book">
            <PlusCircle className="mr-2 h-4 w-4" />
            New Booking
          </Link>
        </Button>
      </div>

      {/* Summary cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Upcoming Bookings
            </CardTitle>
            <CalendarDays className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">0</div>
            <p className="text-xs text-muted-foreground mt-1">
              No bookings scheduled
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Next Stay</CardTitle>
            <BedDouble className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-lg font-semibold text-slate-500">
              No upcoming stays
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Book a stay at the lodge
            </p>
          </CardContent>
        </Card>

        <Card className="sm:col-span-2 lg:col-span-1">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Quick Book</CardTitle>
            <Mountain className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <CardDescription className="mb-4">
              Check availability and book your next alpine getaway.
            </CardDescription>
            <Button asChild size="sm" className="w-full">
              <Link href="/book">Book Now</Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Recent bookings placeholder */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-slate-900">
            Recent Bookings
          </h2>
          <Button variant="outline" size="sm" asChild>
            <Link href="/bookings">View all</Link>
          </Button>
        </div>
        <Card>
          <CardContent className="py-12 text-center">
            <BedDouble className="mx-auto h-10 w-10 text-slate-300 mb-3" />
            <p className="text-sm font-medium text-slate-500">
              No bookings yet
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Your booking history will appear here.
            </p>
            <Button asChild size="sm" className="mt-4">
              <Link href="/book">Make your first booking</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
