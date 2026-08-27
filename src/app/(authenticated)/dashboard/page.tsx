import type { ReactNode } from "react";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { OccupancyMeter } from "@/components/ui/occupancy-meter";
import {
  CalendarDays,
  BedDouble,
  PlusCircle,
  Mountain,
  Home,
  House,
  Shield,
  Wallet,
  CreditCard,
  TicketPercent,
  ClipboardCheck,
  ChevronRight,
  Wrench,
  MessageSquare,
  Users,
} from "lucide-react";
import { formatCents } from "@/lib/utils";
import { CLUB_HUT_LEADER_LABEL, CLUB_NAME } from "@/config/club-identity";
import { bookingStatusClass, bookingStatusLabel } from "@/lib/status-colors";
import { isHutLeader } from "@/lib/hut-leader";
import {
  addCalendarDays,
  calendarDateOfDateOnlyInstant,
  dateOnlyInstantOf,
  formatClubDate,
  formatClubDayMonth,
} from "@/lib/club-time";
import { clubTime } from "@/lib/club-time/server";
import { getMemberCreditBalance } from "@/lib/member-credit";
import {
  isDashboardPaymentOwed,
  summarizeMemberPaymentOwed,
} from "@/lib/member-dashboard";
import {
  getAvailablePromoCodesForMember,
  type AvailablePromoCode,
} from "@/lib/promo";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { canViewCalendarEvents } from "@/lib/calendar-access";
import { RecentNewsCard } from "@/components/recent-news-card";
import { MessageBoardCard } from "@/components/message-board-card";
import { countClubPostsSince } from "@/lib/club-posts";
import {
  buildHrefWithReturnTo,
  buildProfilePathWithReturnTo,
} from "@/lib/internal-return-path";
import { hasAccessRole } from "@/lib/access-roles";
import {
  ACTIVE_BOOKING_STATUSES,
  PAYMENT_OWED_BOOKING_STATUSES,
} from "@/lib/booking-status";
import { checkCapacity } from "@/lib/capacity";

/*
  The three tightest slots on this page — the upcoming-events list (a fixed-width
  `w-14` column), the "Next Stay" summary pair and the draft "Expires" note —
  deliberately drop the year to stay compact, and always have. The admin
  dashboard's twin cards do the same. F3 (#3079) declared that bag as the
  kernel's `dayMonth` shape, so `formatClubDayMonth` replaces the local formatter
  this file kept.

  IT RENDERS CALENDAR DAYS ONLY, and the shape takes no zone (CT-4, #2870): the
  day is encoded at UTC midnight and read back pinned to `UTC`, which is provably
  the identity for every club. Before CT-4 the local formatter was pinned to
  `APP_TIME_ZONE` and handed BOTH lodge nights and real instants, which is one
  concept wearing another's clothes: identical output in New Zealand, and for a
  club west of Greenwich a lodge night rendered a day early.

  Every real instant on this page is projected to the club's calendar day first,
  by `club.calendarDateOf(...)`, which is the one operation allowed to decide
  which day a moment falls on (INV-DATE-019).
*/

function formatPromoBenefitSummary(promo: AvailablePromoCode) {
  if (promo.type === "PERCENTAGE") {
    return promo.percentOff !== null
      ? `${promo.percentOff}% off per individual`
      : "Percentage discount";
  }

  if (promo.type === "FIXED_AMOUNT") {
    return promo.valueCents !== null
      ? `${formatCents(promo.valueCents)} off per individual`
      : "Fixed discount";
  }

  if (promo.type === "FREE_NIGHTS") {
    if (promo.freeNightsPerIndividual === null) {
      return "Free nights";
    }
    return `${promo.freeNightsPerIndividual} free night${promo.freeNightsPerIndividual === 1 ? "" : "s"} per booking`;
  }

  if (promo.type === "FIXED_NIGHTLY_PRICE") {
    return promo.fixedNightlyPriceCents !== null
      ? `${formatCents(promo.fixedNightlyPriceCents)} per eligible night`
      : "Fixed nightly price";
  }

  return "Promo discount";
}

function SummaryLinkCard({
  children,
  href,
  icon,
  title,
}: {
  children: ReactNode;
  href: string;
  icon: ReactNode;
  title: string;
}) {
  return (
    <Link
      className="group block h-full rounded-xl text-card-foreground no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      href={href}
    >
      <Card className="h-full transition-colors group-hover:border-ring group-hover:bg-accent group-focus-visible:border-ring group-focus-visible:bg-accent">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">{title}</CardTitle>
          <span className="flex items-center gap-1 text-muted-foreground transition-colors group-hover:text-foreground group-focus-visible:text-foreground">
            {icon}
            <ChevronRight
              aria-hidden="true"
              className="h-4 w-4 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
            />
          </span>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </Link>
  );
}

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const firstName = session.user.name?.split(" ")[0] ?? "Member";
  const memberId = session.user.id;
  // "Today" has TWO encodings on this page and they are NOT interchangeable
  // (#2838; INV-DATE-013, INV-DATE-019).
  //
  // `today` / `tomorrow` are date-only values — the club's calendar day pinned
  // to UTC midnight — and they are the only thing a `@db.Date` column may be
  // compared against. `Booking.checkIn`, `Booking.checkOut` and the hut-leader
  // assignment dates are all `@db.Date`, and the pg driver adapter narrows a
  // bound `Date` for such a column to its UTC calendar date, discarding the
  // time (`formatDate` in `@prisma/adapter-pg`). The old
  // `new Date()` + `setHours(0, 0, 0, 0)` was NZ-LOCAL midnight — the PREVIOUS
  // UTC day under the `TZ=Pacific/Auckland` server pin — which narrowed to D-1,
  // so every window below ran a full day behind.
  //
  // WHAT THAT COST WAS VISIBILITY, NOT PERMISSION. `getKioskAccessTier`
  // (`src/lib/kiosk-access.ts:31-81`) is the authority on lodge access, derives
  // its day from the club's own calendar, and already implemented
  // `[checkIn-1, checkOut]` and `[startDate-1, endDate]`; every `/api/lodge/*`
  // route enforces it, and both buttons below just link to `/lodge/kiosk`. So on
  // the day BEFORE check-in the member's access already worked and only the
  // button was missing, and on the day AFTER check-out the button that survived
  // pointed at a kiosk answering `tier: "none"` — a dead link, and (for a PAID
  // booking) only until the 01:00 NZ completion cron flipped the status. Nothing
  // here grants or revokes access; it decides which links a member is offered.
  //
  // `startOfTodayNZ` is the INSTANT that same club day begins. It belongs to the
  // real `DateTime` columns further down (`Booking.draftExpiresAt` and
  // `CalendarEvent.startsAt`), which hold moments rather than calendar days and
  // would be pushed to club MIDDAY by a date-only value. Under the server's NZ
  // pin this is the identical instant `setHours(0, 0, 0, 0)` produced, so those
  // two reads are unchanged; deriving it from the club's calendar rather than
  // the process's own zone keeps it right if the process is ever not pinned.
  //
  // AND THE CLUB'S CALENDAR IS NOW THE CLUB'S RECORDED SETTING (CT-4, #2870;
  // INV-CONFIG-002), not `APP_TIME_ZONE`. `getTodayDateOnly()` and
  // `startOfDateOnlyForTimeZone()` both read the container's environment, so on
  // a deployment where the two disagree this whole page ran on the machine's
  // idea of the day. The date-only ends are re-encoded to UTC midnight because
  // that is the only shape a `@db.Date` bind accepts (INV-DATE-026), and the
  // step is whole CALENDAR days rather than 86 400 000 ms so a DST transition
  // cannot move it.
  const club = await clubTime();
  const todayDate = club.today();
  const today = dateOnlyInstantOf(todayDate);
  const tomorrow = dateOnlyInstantOf(addCalendarDays(todayDate, 1));
  const startOfTodayNZ = club.startOfDay(todayDate);

  // Check if member is a staying guest (PAID booking where checkIn-1 <= today <= checkOut)
  //
  // NOT the same subject set as the nav bar's copy of this rule in
  // `src/app/(authenticated)/layout.tsx`, and the difference is worth recording
  // rather than assuming away: this one admits the booking OWNER **or** a linked
  // member guest, while the layout's asks about `memberId` alone. A member
  // linked as somebody else's guest therefore gets this card but not the nav
  // link — and `getKioskAccessTier` (`src/lib/kiosk-access.ts:55-77`), which is
  // the gate that actually decides, carries the guest branch too, so it is the
  // layout that under-offers against the authority. Pre-existing on both sides
  // and untouched by #2838, which changed only the DAY each window asks about.
  const stayingGuestBooking = await prisma.booking.findFirst({
    where: {
      deletedAt: null,
      status: "PAID",
      checkIn: { lte: tomorrow },
      checkOut: { gte: today },
      OR: [{ memberId }, { guests: { some: { memberId } } }],
    },
    select: { id: true },
  });
  const isStayingGuest = !!stayingGuestBooking;

  // Check if member has an active hut leader assignment (day-before access)
  const isHutLeaderActive = hasAccessRole(session.user, "USER")
    ? await isHutLeader(memberId, tomorrow).then(async (dayBefore) => {
        if (dayBefore) return true;
        return isHutLeader(memberId, today);
      })
    : false;

  const [
    upcomingBookings,
    recentBookings,
    draftBookings,
    paymentOwedBookings,
    creditBalanceCents,
    availablePromoCodes,
    lockers,
  ] = await Promise.all([
    prisma.booking.findMany({
      where: {
        deletedAt: null,
        status: { in: [...ACTIVE_BOOKING_STATUSES] },
        // "Upcoming" means checking in today or later. Against the old
        // local-midnight instant this narrowed to D-1, so a stay that began
        // YESTERDAY was still listed as upcoming for one extra day (#2838).
        //
        // This list is not only the Upcoming Bookings count: `upcomingBookings[0]`
        // is `nextStay`, which draws the Next Stay card, its occupancy bar and
        // its call to action. So a member whose stay started yesterday now sees
        // "No upcoming stays" and a link to /book a day earlier than before,
        // possibly while standing in the lodge. That is the right reading for a
        // card named "Next Stay" — the stay in progress is reached from Recent
        // Bookings — but it is a visible change, not only an arithmetic one.
        checkIn: { gte: today },
        OR: [{ memberId }, { guests: { some: { memberId } } }],
      },
      orderBy: { checkIn: "asc" },
      take: 20,
      select: {
        id: true,
        memberId: true,
        lodgeId: true,
        checkIn: true,
        checkOut: true,
        status: true,
        finalPriceCents: true,
        _count: { select: { guests: true } },
      },
    }),
    prisma.booking.findMany({
      where: {
        deletedAt: null,
        status: { not: "DRAFT" },
        OR: [{ memberId }, { guests: { some: { memberId } } }],
      },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        id: true,
        memberId: true,
        checkIn: true,
        checkOut: true,
        status: true,
        finalPriceCents: true,
        createdAt: true,
        _count: { select: { guests: true } },
      },
    }),
    prisma.booking.findMany({
      where: {
        memberId,
        deletedAt: null,
        status: "DRAFT",
        // `draftExpiresAt` is a plain `DateTime` — a real instant, not a lodge
        // night — so it takes the start-of-club-day INSTANT, not the date-only
        // value the `@db.Date` filters above use.
        draftExpiresAt: { gt: startOfTodayNZ },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        checkIn: true,
        checkOut: true,
        finalPriceCents: true,
        draftExpiresAt: true,
        // #2779 — whether an ADMIN saved this draft on the member's behalf.
        // `booking-create.ts` writes `createdById` only for an on-behalf create,
        // so a non-null value is exactly that case. Read here to drive a label
        // and a CTA, never rendered: the acting admin's identity belongs on the
        // booking detail page's own "Created by …" line, not on a dashboard card.
        createdById: true,
        _count: { select: { guests: true } },
      },
    }),
    prisma.booking.findMany({
      where: {
        memberId,
        deletedAt: null,
        status: { in: [...ACTIVE_BOOKING_STATUSES, "COMPLETED"] },
        OR: [
          { status: { in: [...PAYMENT_OWED_BOOKING_STATUSES] } },
          { payment: { is: { additionalAmountCents: { gt: 0 } } } },
        ],
      },
      select: {
        id: true,
        status: true,
        finalPriceCents: true,
        payment: {
          select: {
            status: true,
            additionalAmountCents: true,
            additionalPaymentStatus: true,
          },
        },
      },
    }),
    getMemberCreditBalance(memberId),
    getAvailablePromoCodesForMember(memberId),
    prisma.locker.findMany({
      where: { allocatedToMemberId: memberId },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  const nextStay = upcomingBookings[0] ?? null;

  // "How full for your dates" for the next stay — purely additive, read-only
  // (#1818). Both `filled` and `capacity` are derived from the SAME
  // checkCapacity call: for every night `occupiedBeds + availableBeds` equals
  // the lodge capacity, and `capacity - minAvailable` is peak occupancy across
  // the stay (the member's own party included — correct for "how full for your
  // dates"). Sharing one capacity notion means the meter can never show a
  // spurious filled > capacity. Any missing lodge, zero capacity, or helper
  // failure leaves the card exactly as before (no meter, no crash).
  let nextStayOccupancy: { filled: number; capacity: number } | null = null;
  if (nextStay?.lodgeId) {
    try {
      const { minAvailable, nightDetails } = await checkCapacity(
        nextStay.lodgeId,
        nextStay.checkIn,
        nextStay.checkOut,
        1,
      );
      const firstNight = nightDetails[0];
      if (firstNight) {
        const capacity = firstNight.occupiedBeds + firstNight.availableBeds;
        if (capacity > 0) {
          nextStayOccupancy = { filled: capacity - minAvailable, capacity };
        }
      }
    } catch {
      nextStayOccupancy = null;
    }
  }

  const paymentOwed = summarizeMemberPaymentOwed(paymentOwedBookings);
  const paymentOwedBookingIds = paymentOwedBookings
    .filter(isDashboardPaymentOwed)
    .map((booking) => booking.id);
  const nextStayHref = nextStay
    ? buildHrefWithReturnTo(`/bookings/${nextStay.id}`, "/dashboard")
    : "/book";
  const paymentOwedHref =
    paymentOwed.bookingCount === 1 && paymentOwedBookingIds.length === 1
      ? buildHrefWithReturnTo(
          `/bookings/${paymentOwedBookingIds[0]}`,
          "/dashboard",
        )
      : "/bookings";
  const accountCreditHref = buildProfilePathWithReturnTo(
    "/dashboard",
    "account-credit",
  );
  const promoCodesHref = buildProfilePathWithReturnTo(
    "/dashboard",
    "promo-codes",
  );
  const firstPromoCode = availablePromoCodes[0] ?? null;

  // Lodge induction status for the member-portal card.
  const inductionInfo = await prisma.member.findUnique({
    where: { id: memberId },
    select: {
      requiresInduction: true,
      inductions: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          status: true,
          requiredSignOffs: true,
          _count: { select: { signOffs: true } },
        },
      },
    },
  });
  const latestInduction = inductionInfo?.inductions[0] ?? null;
  const inductionComplete = latestInduction?.status === "COMPLETED";
  const inductionStatusText = inductionComplete
    ? "Complete"
    : latestInduction
      ? `In progress · ${latestInduction._count.signOffs}/${latestInduction.requiredSignOffs} signed`
      : "Not started";
  const inductionNeedsAction =
    Boolean(inductionInfo?.requiresInduction) && !inductionComplete;

  const modules = await loadEffectiveModuleFlags();

  // Headline for the message board tile.
  //
  // Skipped -- query included -- when the board module is off, following the
  // events card below: the dashboard must not read for a surface it is not
  // going to show.
  //
  // Seven CLUB days, stepped over the date-only value rather than derived from
  // the process's own zone (INV-DATE-019), so every viewer is told about the
  // same seven days no matter where they are reading from.
  const recentPostCount = modules.commsPortal
    ? await countClubPostsSince(
        startOfDateOnlyForTimeZone(formatDateOnly(addDaysDateOnly(today, -7))),
      )
    : 0;

  // Upcoming club events for the next two weeks (Events card → /calendar).
  //
  // Skipped entirely — query included — when the club has the eventsCalendar
  // module off, or when the viewer is an organisation account (#2241). The
  // dashboard must never read for, or link to, a surface that would 404 the
  // moment it was clicked.
  const showEventsCard =
    modules.eventsCalendar && canViewCalendarEvents(session.user);
  // `CalendarEvent.startsAt` is a plain `DateTime`, so this window is a pair of
  // INSTANTS: the start of today in club time to the start of the fourteenth day
  // after it.
  //
  // The VALUE is unchanged by #2838, and no daylight-saving bug is being fixed
  // here. The old form was `new Date(today); setDate(getDate() + 14)`, which is
  // local-calendar arithmetic and produces the same instant on every day of
  // 2026, both DST transitions included. What changed is where the day comes
  // from: it is stepped in whole CALENDAR days over the CLUB's date-only value
  // and only then turned back into an instant, rather than being derived from
  // the process's own zone (INV-DATE-019).
  const twoWeeksOut = club.startOfDay(addCalendarDays(todayDate, 14));
  const upcomingEvents = showEventsCard
    ? await prisma.calendarEvent.findMany({
        where: { startsAt: { gte: startOfTodayNZ, lte: twoWeeksOut } },
        orderBy: { startsAt: "asc" },
        take: 6,
        select: {
          id: true,
          title: true,
          startsAt: true,
          allDay: true,
          isMeeting: true,
        },
      })
    : [];

  return (
    <div className="space-y-8">
      {/* Welcome header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">
            Welcome back, {firstName}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {CLUB_NAME} — Member Portal
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link href="/profile">View User Profile</Link>
          </Button>
          <Button asChild>
            <Link href="/book">
              <PlusCircle className="mr-2 h-4 w-4" />
              New Booking
            </Link>
          </Button>
        </div>
      </div>

      {/* Lodge access cards */}
      {(isStayingGuest || isHutLeaderActive) && (
        <div className="flex flex-wrap gap-3">
          {isStayingGuest && (
            <Button asChild variant="outline" className="gap-2">
              <Link href="/lodge/kiosk">
                <Home className="h-4 w-4" />
                View Lodge
              </Link>
            </Button>
          )}
          {isHutLeaderActive && (
            <Button asChild variant="outline" className="gap-2">
              <Link href="/lodge/kiosk">
                <Shield className="h-4 w-4" />
                {CLUB_HUT_LEADER_LABEL}
              </Link>
            </Button>
          )}
        </div>
      )}

      {/* Recent news (member notices module). Renders nothing when the member
          has no visible notices. */}
      {modules.memberNotices && <RecentNewsCard memberId={memberId} />}

      {/* Summary cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <SummaryLinkCard
          href="/bookings"
          icon={<CalendarDays aria-hidden="true" className="h-4 w-4" />}
          title="Upcoming Bookings"
        >
          <div className="text-3xl font-bold">{upcomingBookings.length}</div>
          <p className="text-xs text-muted-foreground mt-1">
            {upcomingBookings.length === 0
              ? "No bookings scheduled"
              : `${upcomingBookings.length} booking${upcomingBookings.length !== 1 ? "s" : ""} coming up`}
          </p>
        </SummaryLinkCard>

        <SummaryLinkCard
          href={nextStayHref}
          icon={<BedDouble aria-hidden="true" className="h-4 w-4" />}
          title="Next Stay"
        >
          {nextStay ? (
            <>
              <div className="text-lg font-semibold">
                {formatClubDayMonth(
                  calendarDateOfDateOnlyInstant(nextStay.checkIn),
                )}
                {" — "}
                {formatClubDayMonth(
                  calendarDateOfDateOnlyInstant(nextStay.checkOut),
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {nextStay._count.guests} guest
                {nextStay._count.guests !== 1 ? "s" : ""} ·{" "}
                {formatCents(nextStay.finalPriceCents)}
              </p>
              {nextStayOccupancy ? (
                <OccupancyMeter
                  className="mt-3"
                  size="sm"
                  label="Lodge occupancy for your dates"
                  filled={nextStayOccupancy.filled}
                  capacity={nextStayOccupancy.capacity}
                />
              ) : null}
            </>
          ) : (
            <>
              <div className="text-lg font-semibold text-muted-foreground">
                No upcoming stays
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Book a stay at the lodge
              </p>
            </>
          )}
        </SummaryLinkCard>

        <SummaryLinkCard
          href={accountCreditHref}
          icon={<Wallet aria-hidden="true" className="h-4 w-4" />}
          title="Account Credit"
        >
          <div className="text-3xl font-bold">
            {formatCents(creditBalanceCents)}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {creditBalanceCents > 0
              ? "Available account credit for future bookings"
              : "No account credit available"}
          </p>
        </SummaryLinkCard>

        <SummaryLinkCard
          href={paymentOwedHref}
          icon={<CreditCard aria-hidden="true" className="h-4 w-4" />}
          title="Payment Owed"
        >
          <div className="text-3xl font-bold">
            {formatCents(paymentOwed.totalCents)}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {paymentOwed.totalCents > 0
              ? `${paymentOwed.bookingCount} booking${paymentOwed.bookingCount !== 1 ? "s" : ""} need payment`
              : "No payment due"}
          </p>
        </SummaryLinkCard>

        {showEventsCard && (
          <SummaryLinkCard
            href="/calendar"
            icon={<CalendarDays aria-hidden="true" className="h-4 w-4" />}
            title="Events"
          >
            {upcomingEvents.length === 0 ? (
              <>
                <div className="text-lg font-semibold text-muted-foreground">
                  No upcoming events
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Nothing scheduled in the next two weeks
                </p>
              </>
            ) : (
              <ul className="space-y-2">
                {upcomingEvents.map((event) => (
                  <li
                    key={event.id}
                    className="flex items-baseline gap-2 text-sm"
                  >
                    <span className="w-14 shrink-0 text-xs font-medium text-muted-foreground">
                      {formatClubDayMonth(club.calendarDateOf(event.startsAt))}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-foreground">
                      {event.title}
                      {event.isMeeting && (
                        <span className="ml-1 text-xs text-primary">
                          · Meeting
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {event.allDay
                        ? "All day"
                        : club.instantTime(event.startsAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </SummaryLinkCard>
        )}

        {modules.promoCodes && (
          <SummaryLinkCard
            href={promoCodesHref}
            icon={<TicketPercent aria-hidden="true" className="h-4 w-4" />}
            title="Promo Codes Available"
          >
            <div className="text-3xl font-bold">
              {availablePromoCodes.length}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {availablePromoCodes.length > 0
                ? "Assigned to your member account"
                : "No assigned promo codes available"}
            </p>
            {firstPromoCode ? (
              <p className="mt-2 break-words text-xs font-medium text-foreground">
                {firstPromoCode.code} ·{" "}
                {formatPromoBenefitSummary(firstPromoCode)}
              </p>
            ) : null}
          </SummaryLinkCard>
        )}

        <Card>
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

        {modules.induction && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                Lodge Induction
              </CardTitle>
              <ClipboardCheck className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-lg font-semibold">{inductionStatusText}</div>
              <p className="text-xs text-muted-foreground mt-1">
                {inductionNeedsAction
                  ? "Your induction is required — please complete it."
                  : "View your induction and sign off others."}
              </p>
              <Button
                asChild
                size="sm"
                variant={inductionNeedsAction ? "default" : "outline"}
                className="mt-4 w-full"
              >
                <Link href="/induction">Open Induction</Link>
              </Button>
            </CardContent>
          </Card>
        )}

        {/* #2780. Gated on the module only — the QR path's own setting is
            irrelevant here, because this card is the signed-in door. */}
        {modules.maintenanceReports && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                Lodge Maintenance Issue
              </CardTitle>
              <Wrench className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-lg font-semibold">Something need fixing?</div>
              <p className="text-xs text-muted-foreground mt-1">
                Tell whoever looks after the lodge, with a photo if you have one.
              </p>
              <Button asChild size="sm" variant="outline" className="mt-4 w-full">
                <Link href="/maintenance-report">Report an issue</Link>
              </Button>
            </CardContent>
          </Card>
        )}

        {modules.lockers && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Lockers</CardTitle>
              <House className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {lockers.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No lockers allocated.
                </p>
              ) : (
                <ul className="space-y-1">
                  {lockers.map((locker) => (
                    <li key={locker.id} className="text-sm text-foreground">
                      {locker.name}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        )}

        {/* Message board tile. Gated on the same module as the board itself:
            /message-board is feature-routed on `commsPortal`, so an ungated
            tile would be a button to a blocked route. */}
        {modules.commsPortal && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                Message Board
              </CardTitle>
              <MessageSquare className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-lg font-semibold">
                {recentPostCount} new message{recentPostCount === 1 ? "" : "s"}
              </div>
              <Button asChild size="sm" variant="outline" className="mt-4 w-full">
                <Link href="/message-board">Open Message Board</Link>
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Kiosk tile. `/lodge` is feature-routed on `kiosk`, hence the gate.
            Deliberately NOT gated on kiosk access tier: a member with no tier
            gets the read-only lodge view rather than a refusal, which is the
            "who is in the lodge" this card offers. */}
        {modules.kiosk && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Lodge Kiosk</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-lg font-semibold">Who is in the lodge</div>
              <p className="text-xs text-muted-foreground mt-1">
                The lodge kiosk will show you who is arriving and leaving the
                lodge.
              </p>
              <Button asChild size="sm" variant="outline" className="mt-4 w-full">
                <Link href="/lodge/kiosk">Open Kiosk</Link>
              </Button>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Draft bookings */}
      {draftBookings.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-foreground">
              Draft Bookings
            </h2>
          </div>
          <Card>
            <CardContent className="pt-4">
              <div className="divide-y">
                {draftBookings.map((booking) => {
                  // #2779 — an on-behalf draft is one the member never started,
                  // so "Resume" was the wrong word for the one case where the
                  // member most needs to act: a subscription-locked member whose
                  // only open door is picking this booking up and paying for it.
                  const savedByClub = booking.createdById !== null;
                  // …but only a PRICED draft has that door. At $0 the booking
                  // page shows no payment card (it gates on finalPriceCents > 0)
                  // and offers Confirm instead, which `confirm-draft` refuses for
                  // a locked-out non-admin — so "Review & pay" would send this
                  // member to a button that 403s them (INV-LOCKOUT-070). The
                  // price is already selected for the line above it, so telling
                  // the truth here costs nothing.
                  const savedByClubAndPayable =
                    savedByClub && booking.finalPriceCents > 0;
                  return (
                  <div
                    key={booking.id}
                    className="flex items-center justify-between py-3"
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-sm">
                        {formatClubDate(
                          calendarDateOfDateOnlyInstant(booking.checkIn),
                        )}
                        {" — "}
                        {formatClubDate(
                          calendarDateOfDateOnlyInstant(booking.checkOut),
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {booking._count.guests} guest
                        {booking._count.guests !== 1 ? "s" : ""} ·{" "}
                        {formatCents(booking.finalPriceCents)}
                        {booking.draftExpiresAt && (
                          <span className="text-warning-11 ml-2">
                            Expires{" "}
                            {formatClubDayMonth(
                              club.calendarDateOf(booking.draftExpiresAt),
                            )}
                          </span>
                        )}
                      </p>
                      {savedByClub && (
                        <p
                          className="text-xs text-info-11"
                          data-testid="draft-saved-by-club"
                        >
                          {savedByClubAndPayable
                            ? "Saved for you by the club — open it to check the details and pay."
                            : "Saved for you by the club — there is nothing to pay, so ask the club to confirm it."}
                        </p>
                      )}
                    </div>
                    <Button asChild size="sm" variant="outline">
                      <Link
                        href={buildHrefWithReturnTo(
                          `/bookings/${booking.id}`,
                          "/dashboard",
                        )}
                      >
                        {savedByClubAndPayable
                          ? "Review & pay"
                          : savedByClub
                            ? "Open"
                            : "Resume"}
                      </Link>
                    </Button>
                  </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Recent bookings */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-foreground">
            Recent Bookings
          </h2>
          <Button variant="outline" size="sm" asChild>
            <Link href="/bookings">View all</Link>
          </Button>
        </div>
        <Card>
          {recentBookings.length === 0 ? (
            <CardContent className="py-12 text-center">
              <BedDouble className="mx-auto h-10 w-10 text-muted-foreground/60 mb-3" />
              <p className="text-sm font-medium text-muted-foreground">
                No bookings yet
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Your booking history will appear here.
              </p>
              <Button asChild size="sm" className="mt-4">
                <Link href="/book">Make your first booking</Link>
              </Button>
            </CardContent>
          ) : (
            <CardContent className="pt-4">
              <div className="divide-y">
                {recentBookings.map((booking) => (
                  <Link
                    key={booking.id}
                    href={buildHrefWithReturnTo(
                      `/bookings/${booking.id}`,
                      "/dashboard",
                    )}
                    className="flex items-center justify-between py-3 hover:bg-accent -mx-2 px-2 rounded"
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-sm">
                        {formatClubDate(
                          calendarDateOfDateOnlyInstant(booking.checkIn),
                        )}
                        {" — "}
                        {formatClubDate(
                          calendarDateOfDateOnlyInstant(booking.checkOut),
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {booking._count.guests} guest
                        {booking._count.guests !== 1 ? "s" : ""} ·{" "}
                        {formatCents(booking.finalPriceCents)}
                      </p>
                    </div>
                    <Badge
                      variant="secondary"
                      className={bookingStatusClass(booking.status)}
                    >
                      {bookingStatusLabel(booking.status)}
                    </Badge>
                  </Link>
                ))}
              </div>
            </CardContent>
          )}
        </Card>
      </div>

      {/* Club message board (commsPortal module). Last on the page, below the
          booking lists. Renders nothing when the board is empty, so a club
          that has not started using it sees no empty shell. */}
      {modules.commsPortal && <MessageBoardCard memberId={memberId} />}
    </div>
  );
}
