import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { auth } from "@/lib/auth";
import {
  canManageCalendarEvents,
  canViewCalendarEvents,
} from "@/lib/calendar-access";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { canViewWorkParties } from "@/lib/work-party-access";
import { CalendarView } from "@/components/calendar/calendar-view";
import { CLUB_NAME } from "@/config/club-identity";

export const metadata = {
  title: "Events Calendar",
};

export default async function MemberCalendarPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  // LOAD-BEARING, not belt-and-braces (#2241). The proxy's feature-route gate
  // enforces the MODULE FLAG and nothing else — `FEATURE_ROUTE_RULES` in
  // `src/config/feature-routes.ts` lists route prefixes and never reads the
  // account type — so the ORG exclusion below exists in this file alone.
  // Delete it as "duplicated middleware" and an organisation account can read
  // the club's calendar. The module check beside it is the ordinary case of a
  // page re-checking its own precondition: one call, and it keeps the rule true
  // wherever this page is rendered from.
  const modules = await loadEffectiveModuleFlags();
  if (!modules.eventsCalendar) {
    notFound();
  }
  if (!canViewCalendarEvents(session.user)) {
    notFound();
  }

  const canManage = await canManageCalendarEvents(session.user);

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to dashboard
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-foreground">
          Events Calendar
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Upcoming meetings and events at {CLUB_NAME}.
          {canManage
            ? " Click a day to add an event. Open an event to view it or join its meeting."
            : " Select an event to see its details."}
        </p>
      </div>
      {/* Existing events are read-only here (create-and-view); full editing and
          deletion live on /admin/calendar. */}
      <CalendarView
        canManage={canManage}
        allowEditExisting={false}
        workPartyLink={
          modules.workParties && canViewWorkParties(session.user)
            ? "member"
            : null
        }
      />
    </div>
  );
}
