import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, CalendarDays, MapPin, TicketPercent } from "lucide-react";
import { auth } from "@/lib/auth";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { clubTime, clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import {
  formatClubLongWeekdayDate,
  requireCalendarDate,
} from "@/lib/club-time";
import { canViewWorkParties } from "@/lib/work-party-access";
import { findMemberWorkParty } from "@/lib/work-party-member";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const metadata = {
  title: "Work Party",
};

/**
 * A work party as a member sees it (fork #118): name, dates, lodge,
 * description and discount, with "Join Work Party" while it can still be
 * joined. Joining is a booking with the work party ticked — the button opens
 * the booking page with the stay filled in, and every booking rule still
 * applies there.
 *
 * The members-only check is LOAD-BEARING: the proxy's feature-route gate
 * enforces the `workParties` module and nothing else, so `canViewWorkParties`
 * here is the only thing keeping an organisation account or a non-member login
 * out (owner decision 7). An inactive or unknown id is a 404.
 */
export default async function MemberWorkPartyPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const modules = await loadEffectiveModuleFlags();
  if (!modules.workParties || !canViewWorkParties(session.user)) {
    notFound();
  }

  const { id } = await params;
  const [workParty, club] = await Promise.all([
    clubTodayDateOnlyInstant().then((today) => findMemberWorkParty(id, today)),
    clubTime(),
  ]);
  if (!workParty) notFound();

  const firstNight = formatClubLongWeekdayDate(
    requireCalendarDate(workParty.startDate),
    club.format,
  );
  const lastNight = formatClubLongWeekdayDate(
    requireCalendarDate(workParty.endDate),
    club.format,
  );
  const sameDay = workParty.startDate === workParty.endDate;

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft aria-hidden="true" className="h-4 w-4" />
          Back to dashboard
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-foreground">
          {workParty.name}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">Work party</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
          {workParty.join && (
            <CardDescription>
              Book nights inside the work party and tick &ldquo;I am attending
              a working bee&rdquo; to get the discount.
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="flex items-center gap-2">
            <CalendarDays aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
            {sameDay ? (
              <span>The night of {firstNight}</span>
            ) : (
              <span>
                The nights of {firstNight} to {lastNight}
              </span>
            )}
          </p>
          <p className="flex items-center gap-2">
            <MapPin aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
            <span>{workParty.lodgeName ?? "Any lodge"}</span>
          </p>
          <p className="flex items-center gap-2">
            <TicketPercent aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
            <span>
              {workParty.discountPercent}% off your nights inside the work party
            </span>
          </p>
          {workParty.description && (
            <p className="whitespace-pre-wrap text-foreground">
              {workParty.description}
            </p>
          )}
        </CardContent>
      </Card>

      {workParty.join ? (
        <div className="space-y-2">
          <Button asChild>
            <Link href={`/book?workParty=${encodeURIComponent(workParty.id)}`}>
              Join Work Party
            </Link>
          </Button>
          <p className="text-xs text-muted-foreground">
            Opens the booking page with the stay
            {workParty.lodgeName ? " and lodge" : ""} filled in. You still
            choose your guests and pay as usual, and the usual booking rules
            apply.
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          This work party has finished.
        </p>
      )}
    </div>
  );
}
