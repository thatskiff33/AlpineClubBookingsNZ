// ---------------------------------------------------------------------------
// LOAD VOLUME SEED  —  `pnpm run load:seed-volume` (#4940)
//
// Gives the throwaway load-test stack a club-sized history, so admin lists,
// reports and member reads are measured against thousands of rows instead of
// the demo seed's handful. By default: 2,000 members and five years of the
// club's seasons of past bookings, with member and non-member guests,
// per-night price rows, card and Internet Banking payments, cancellations
// refunded to card or credited to the member's account. Every volume member
// is also bookable today, so the k6 write scenarios can log in as one: a
// confirmed profile, and a PAID subscription for the current and next season
// (the season year comes from the STORED year-end only — the seed refuses a
// stack with a Xero connection rather than ask Xero).
//
// Every row is written through the demo seed's own writers
// (`prisma/demo-seed-writers.ts`, INV-SSOT) in the demo-seed shapes. History
// lies in past seasons, which the real create path refuses (retroactive
// creates stop at a year back), so the demo-seed shapes are the sanctioned
// route for it. The plan itself is pure and unit-tested
// (`prisma/load-volume-plan.ts`): capacity is never exceeded, no member is
// booked twice on one night, and every night is before the club's today.
//
// SAFETY GUARD, before the first read: the load harness's database guard
// (`assertSafeDatabaseTarget`: LOAD_TEST_CONFIRM_TARGET=1, a local host, an
// explicit port that is never 5432), then the demo seed's own guard
// (ALLOW_DEMO_SEED=1, not production, a local host, and no non-demo member
// with a booking). It refuses a database that already holds volume members
// rather than doubling them; reset the stack to re-seed.
//
// Tunables (all optional): LOAD_VOLUME_MEMBERS (2000), LOAD_VOLUME_SEASONS
// (5 years back), LOAD_VOLUME_SEED (4940).
// ---------------------------------------------------------------------------
import { PrismaClient } from "@prisma/client";
import { assertSafeDatabaseTarget } from "../load/lib/target-guard.js";
import { assertDemoSeedMayRun, DEMO_SEED_DOMAIN } from "../src/lib/demo-seed-guard";
import { createPrismaPgAdapter } from "../src/lib/prisma-adapter";
import { getLodgeCapacity } from "../src/lib/lodge-capacity";
import { clubTime } from "../src/lib/club-time/server";
import {
  addCalendarDays,
  calendarDateOfDateOnlyInstant,
  requireInstant,
  type CalendarDate,
} from "../src/lib/club-time";
import { getClubFormat } from "../src/lib/club-format-settings";
import { stripeChargeCurrency } from "../src/lib/stripe-charge-currency";
import { seasonYearOfCalendarDate } from "../src/lib/financial-year";
import { getStoredFinancialYearResolution } from "../src/lib/financial-year-server";
import { readXeroConnection } from "../src/lib/xero-connection";
import { backfillCurrentSeasonMembershipAssignments } from "../src/lib/membership-types";
import {
  addDemoGuest,
  createDemoMember,
  createDemoBooking,
  createDemoPrimaryPayment,
  createDemoPaymentRefund,
  createDemoCancellationCredit,
  demoDate,
  demoNightsBetween,
  demoSeedPasswordHash,
  DEMO_MEMBER_NIGHTLY_CENTS as NIGHTLY_CENTS,
} from "./demo-seed-writers";
import {
  LOAD_VOLUME_DEFAULTS,
  LOAD_VOLUME_EMAIL_PREFIX,
  pastSeasonWindows,
  planLoadVolume,
  type LoadVolumeBooking,
  type LoadVolumeLodge,
} from "./load-volume-plan";

// Bookings written at once; small enough for the app's default pool.
const WRITE_CONCURRENCY = 4;

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer (got "${raw}").`);
  }
  return value;
}

function calendarDayOf(value: Date): CalendarDate {
  return calendarDateOfDateOnlyInstant(requireInstant(value));
}

async function main() {
  // Guard first: nothing below may read or write until both pass.
  assertSafeDatabaseTarget(process.env);
  const prisma = new PrismaClient({ adapter: createPrismaPgAdapter() });
  try {
    await assertDemoSeedMayRun({
      env: process.env,
      // The base seed's own admin and kiosk accounts sit outside the demo
      // domain on every seeded stack; a non-demo member with a booking is
      // what real club data looks like, so that is what refuses.
      countNonDemoMembers: () =>
        prisma.member.count({
          where: {
            NOT: { email: { endsWith: `@${DEMO_SEED_DOMAIN}` } },
            bookings: { some: {} },
          },
        }),
    });
    await seed(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

async function seed(prisma: PrismaClient) {
  const existing = await prisma.member.count({
    where: { email: { startsWith: LOAD_VOLUME_EMAIL_PREFIX, endsWith: `@${DEMO_SEED_DOMAIN}` } },
  });
  if (existing > 0) {
    throw new Error(
      `Refusing to seed volume: ${existing} volume member(s) already exist. ` +
        "Reset the stack (pnpm run test:e2e:down && pnpm run test:e2e:prepare) first.",
    );
  }

  const today = (await clubTime()).today();
  const format = await getClubFormat();
  const refundCurrency = stripeChargeCurrency(format);
  const memberCount = positiveIntEnv("LOAD_VOLUME_MEMBERS", LOAD_VOLUME_DEFAULTS.memberCount);
  const seasonsBack = positiveIntEnv("LOAD_VOLUME_SEASONS", LOAD_VOLUME_DEFAULTS.seasonsBack);
  const seed = positiveIntEnv("LOAD_VOLUME_SEED", LOAD_VOLUME_DEFAULTS.seed);

  // Refuse even when a year-end override would make resolution provider-free.
  if (await readXeroConnection(prisma)) {
    throw new Error("Refusing to seed volume: a Xero connection is stored; the load stack must not have one.");
  }
  // Provider-free: the stored override or the no-Xero default, never a Xero call.
  const yearEnd = await getStoredFinancialYearResolution(prisma);
  if (!yearEnd.ok) {
    throw new Error("Refusing to seed volume: a Xero connection is stored; the load stack must not have one.");
  }
  const currentSeason = seasonYearOfCalendarDate(today, yearEnd.effectiveMonth);

  const lodges: LoadVolumeLodge[] = [];
  for (const lodge of await prisma.lodge.findMany({ where: { active: true }, orderBy: { name: "asc" } })) {
    const seasons = (
      await prisma.season.findMany({ where: { lodgeId: lodge.id, active: true } })
    ).map((season) => ({
      start: calendarDayOf(season.startDate),
      // Season.endDate is the last bookable night; the plan works half-open.
      endExclusive: addCalendarDays(calendarDayOf(season.endDate), 1),
    }));
    const windows = pastSeasonWindows(seasons, seasonsBack, today);
    if (windows.length === 0) continue;
    const nights = await prisma.bookingGuestNight.groupBy({
      by: ["stayDate"],
      where: {
        bookingGuest: { booking: { lodgeId: lodge.id } },
        stayDate: { gte: demoDate(windows[0]!.start), lt: demoDate(today) },
      },
      _count: { _all: true },
    });
    lodges.push({
      id: lodge.id,
      capacity: await getLodgeCapacity(lodge.id),
      seasons,
      occupied: new Map(nights.map((row) => [calendarDayOf(row.stayDate), row._count._all])),
    });
  }
  if (lodges.length === 0) {
    throw new Error("Refusing to seed volume: no active lodge has a season to shift into the past.");
  }

  const plan = planLoadVolume({ ...LOAD_VOLUME_DEFAULTS, memberCount, seasonsBack, seed, today, lodges });
  const earliest = plan.bookings.reduce<string>((min, b) => (b.checkIn < min ? b.checkIn : min), today);
  console.log(
    `Seeding ${plan.members.length} members and ${plan.bookings.length} past bookings ` +
      `across ${lodges.length} lodge(s), ${earliest}..${today}...`,
  );

  // Every volume member is a bookable member: a complete, self-confirmed
  // profile (the demo seed's `seedConfirmedPaidMember` shape), so the booking
  // guest-profile gate and the onboarding modal never stop a load VU, and a
  // PAID subscription for every season a load run books into, so the default
  // HARD_BLOCK lockout (INV-LOCKOUT) never refuses one. The write scenarios
  // (`load/scenarios/mixed-writes.js`, `payment-path.js`) log in as them.
  const passwordHash = demoSeedPasswordHash();
  const confirmedAt = new Date();
  const memberIds: string[] = [];
  for (const member of plan.members) {
    const row = await createDemoMember(prisma, passwordHash, member.local, member.firstName, member.lastName, {
      joinedDate: demoDate(earliest),
      dateOfBirth: demoDate("1985-03-14"),
      phoneCountryCode: "64",
      phoneAreaCode: "21",
      phoneNumber: String(6000000 + member.index),
      streetAddressLine1: "8 Summit Way",
      streetCity: "Alpine Village",
      streetRegion: "Waikato",
      streetPostalCode: "3420",
      streetCountry: "New Zealand",
      postalAddressLine1: "8 Summit Way",
      postalCity: "Alpine Village",
      postalRegion: "Waikato",
      postalPostalCode: "3420",
      postalCountry: "New Zealand",
      profileCompletedAt: confirmedAt,
      detailsConfirmedAt: confirmedAt,
      onboardingConfirmedAt: confirmedAt,
    });
    await prisma.member.update({ where: { id: row.id }, data: { detailsConfirmedByMemberId: row.id } });
    memberIds.push(row.id);
  }
  for (const seasonYear of [currentSeason, currentSeason + 1]) {
    await prisma.memberSubscription.createMany({
      data: memberIds.map((memberId) => ({ memberId, seasonYear, status: "PAID" as const, paidAt: confirmedAt })),
      skipDuplicates: true,
    });
    await backfillCurrentSeasonMembershipAssignments(prisma, seasonYear);
  }

  const memberId = (index: number) => {
    const id = memberIds[index];
    if (!id) throw new Error(`load volume seed: no member at index ${index}`);
    return id;
  };

  const writeBooking = async (planned: LoadVolumeBooking) => {
    const ownerId = memberId(planned.ownerIndex);
    const nights = demoNightsBetween(planned.checkIn, planned.checkOut).length;
    const total = NIGHTLY_CENTS * nights * planned.guests.length;
    const booking = await createDemoBooking(prisma, {
      memberId: ownerId,
      lodgeId: planned.lodgeId,
      status: planned.outcome,
      checkIn: demoDate(planned.checkIn),
      checkOut: demoDate(planned.checkOut),
      totalPriceCents: total,
      hasNonMembers: planned.guests.some((guest) => guest.kind === "guest"),
    });
    for (const guest of planned.guests) {
      const departed = planned.outcome === "COMPLETED";
      if (guest.kind === "member") {
        const member = plan.members[guest.memberIndex]!;
        await addDemoGuest(prisma, booking.id, {
          firstName: member.firstName,
          lastName: member.lastName,
          ageTier: "ADULT",
          isMember: true,
          memberId: memberId(guest.memberIndex),
          arrivedAt: departed ? demoDate(planned.checkIn) : null,
          departedAt: departed ? demoDate(planned.checkOut) : null,
        }, planned.checkIn, planned.checkOut, NIGHTLY_CENTS);
      } else {
        await addDemoGuest(prisma, booking.id, {
          firstName: guest.firstName,
          lastName: guest.lastName,
          ageTier: guest.ageTier,
          arrivedAt: departed ? demoDate(planned.checkIn) : null,
          departedAt: departed ? demoDate(planned.checkOut) : null,
        }, planned.checkIn, planned.checkOut, NIGHTLY_CENTS);
      }
    }

    const card = planned.paymentSource === "STRIPE";
    const intentId = card ? `pi_load_${planned.index}` : null;
    const reference = card ? null : `LOAD-IB-${planned.index}`;
    const refunded = planned.cancellationSettlement === "STRIPE_REFUND";
    const { payment, transaction } = await createDemoPrimaryPayment(prisma, {
      bookingId: booking.id,
      amountCents: total,
      source: planned.paymentSource,
      status: refunded ? "REFUNDED" : "SUCCEEDED",
      refundedAmountCents: refunded ? total : 0,
      stripePaymentIntentId: intentId,
      reference,
    });
    await prisma.bookingEvent.create({ data: { bookingId: booking.id, type: "CREATED", actorMemberId: ownerId } });
    await prisma.bookingEvent.create({
      data: { bookingId: booking.id, type: "MEMBER_PAID", actorMemberId: ownerId, amountCents: total },
    });

    if (planned.outcome === "CANCELLED") {
      await prisma.bookingEvent.create({
        data: { bookingId: booking.id, type: "CANCELLED", actorMemberId: ownerId, reason: "Change of plans" },
      });
      if (refunded) {
        await createDemoPaymentRefund(prisma, {
          paymentId: payment.id,
          paymentTransactionId: transaction.id,
          stripeRefundId: `re_load_${planned.index}`,
          stripePaymentIntentId: intentId,
          amountCents: total,
          currency: refundCurrency,
          reason: "Cancellation refund",
          stripeCreatedAt: demoDate(planned.checkIn),
        });
        await prisma.bookingEvent.create({ data: { bookingId: booking.id, type: "REFUNDED", amountCents: total } });
      } else {
        await createDemoCancellationCredit(prisma, {
          memberId: ownerId,
          amountCents: total,
          description: "Credit from cancelled booking",
          sourceBookingId: booking.id,
        });
        await prisma.bookingEvent.create({ data: { bookingId: booking.id, type: "CREDITED", amountCents: total } });
      }
    }
  };

  for (let start = 0; start < plan.bookings.length; start += WRITE_CONCURRENCY) {
    await Promise.all(plan.bookings.slice(start, start + WRITE_CONCURRENCY).map(writeBooking));
    if (start % 500 === 0 && start > 0) console.log(`  ${start} / ${plan.bookings.length} bookings`);
  }

  const guestNights = plan.bookings.reduce(
    (sum, b) => sum + b.guests.length * demoNightsBetween(b.checkIn, b.checkOut).length,
    0,
  );
  console.log(
    `Volume seeded: ${plan.members.length} members, ${plan.bookings.length} bookings, ${guestNights} guest-nights, ` +
      `${plan.bookings.filter((b) => b.outcome === "CANCELLED").length} cancelled.`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
