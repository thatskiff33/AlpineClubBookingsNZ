// E2E multi-lodge provisioning: add a SECOND active lodge (lodge B) with its
// own rooms, seasons, a kiosk binding, and the deterministic fixtures the
// `multi-lodge` Playwright project asserts on. Run by
// scripts/e2e-stack.sh ONLY when E2E_MULTI_LODGE=1, AFTER prisma/seed.ts (so
// lodge A's Winter/Summer seasons already exist to mirror). The default
// single-lodge suite never runs this, so it never sees a second lodge and its
// behaviour is byte-identical.
//
// This is provisioning for a coverage project (a blocking CI check since
// #1655) and is NOT a substitute for the manual two-lodge staging matrix in
// docs/multi-lodge/test-plan.md.
//
// Idempotent: the stack drops the schema before every prepare and the demo
// seed clears bookings each run, but this script also clears its own fixtures
// up front so a standalone re-run is safe.
import { BookingStatus, PrismaClient } from "@prisma/client";
import { createPrismaPgAdapter } from "../../src/lib/prisma-adapter";
import { getDefaultLodgeId } from "../../src/lib/lodges";
import { quoteWaitlistEntryAtLodge } from "../../src/lib/waitlist-cross-lodge";
import {
  CAPACITY_ISOLATION_GUEST_COUNT,
  CAPACITY_ISOLATION_WINDOW,
  CROSS_LODGE_OFFER_BOOKING_ID,
  CROSS_LODGE_OFFER_MEMBER_GUEST_BOOKING_ID,
  CROSS_LODGE_OFFER_MEMBER_GUEST_WINDOW,
  CROSS_LODGE_OFFER_WINDOW,
  ROLE_PERSONAS,
  ROSTER_GUEST_LODGE_A,
  ROSTER_GUEST_LODGE_B,
  ROSTER_ISOLATION_WINDOW,
  SECOND_LODGE,
  SECOND_LODGE_BED_COUNT,
  shiftDateOnly,
  WAITLISTER,
} from "../../prisma/e2e-fixtures";

const prisma = new PrismaClient({ adapter: createPrismaPgAdapter() });

// Deterministic id for the lodge-A roster arrival so the up-front cleanup can
// target it (it lives on lodge A, so lodgeId-scoped deletion cannot reach it).
const ROSTER_LODGE_A_BOOKING_ID = "e2e-roster-lodge-a";

// Date-only helper (schema uses @db.Date for booking/guest dates).
function d(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}

// Nights actually slept = [checkIn, checkOut) — the checkout day is not a night.
function nightsBetween(checkIn: string, checkOut: string): string[] {
  const out: string[] = [];
  for (let night = checkIn; night < checkOut; night = shiftDateOnly(night, 1)) {
    out.push(night);
  }
  return out;
}

// Flat nightly figure for the seeded capacity/roster holds. These bookings are
// asserted on occupancy and roster visibility, never on price, so the exact
// figure is irrelevant. The cross-lodge offer's price is computed properly.
const NIGHTLY_CENTS = 4500;

async function createBookingWithGuests(opts: {
  id?: string;
  memberId: string;
  lodgeId: string;
  status: BookingStatus;
  checkIn: string;
  checkOut: string;
  guests: Array<{
    firstName: string;
    lastName: string;
    isMember: boolean;
    memberId?: string | null;
  }>;
  extra?: Record<string, unknown>;
}) {
  const nights = nightsBetween(opts.checkIn, opts.checkOut);
  const perGuestCents = NIGHTLY_CENTS * nights.length;
  const total = perGuestCents * opts.guests.length;
  const booking = await prisma.booking.create({
    data: {
      ...(opts.id ? { id: opts.id } : {}),
      memberId: opts.memberId,
      lodgeId: opts.lodgeId,
      status: opts.status,
      checkIn: d(opts.checkIn),
      checkOut: d(opts.checkOut),
      totalPriceCents: total,
      finalPriceCents: total,
      ...(opts.extra ?? {}),
    },
  });
  for (const guest of opts.guests) {
    const guestRow = await prisma.bookingGuest.create({
      data: {
        bookingId: booking.id,
        firstName: guest.firstName,
        lastName: guest.lastName,
        ageTier: "ADULT",
        isMember: guest.isMember,
        memberId: guest.memberId ?? null,
        stayStart: d(opts.checkIn),
        stayEnd: d(opts.checkOut),
        priceCents: perGuestCents,
      },
    });
    for (const night of nights) {
      await prisma.bookingGuestNight.create({
        data: {
          bookingGuestId: guestRow.id,
          stayDate: d(night),
          priceCents: NIGHTLY_CENTS,
          priceSource: "SOLD",
        },
      });
    }
  }
  return booking;
}

async function main() {
  const lodgeAId = await getDefaultLodgeId(prisma);

  // 1. Lodge B. Intended to sort after lodge A so getDefaultLodgeId() keeps
  //    resolving lodge A — but createdAt ordering alone is NOT safe here: the
  //    migration seeds lodge A's createdAt with the database's
  //    CURRENT_TIMESTAMP, which under the staging stack's
  //    PGTZ=Pacific/Auckland renders NZ local time (~12h ahead of the UTC
  //    timestamps Prisma clients write), so lodge B would sort "earlier" and
  //    silently become the club default for every runtime fallback (#1627).
  //    Normalised right after the upsert, then asserted.
  const lodgeB = await prisma.lodge.upsert({
    where: { id: SECOND_LODGE.id },
    update: { name: SECOND_LODGE.name, slug: SECOND_LODGE.slug, active: true },
    create: {
      id: SECOND_LODGE.id,
      name: SECOND_LODGE.name,
      slug: SECOND_LODGE.slug,
      active: true,
    },
  });
  const lodgeBId = lodgeB.id;

  const lodgeA = await prisma.lodge.findUniqueOrThrow({
    where: { id: lodgeAId },
    select: { createdAt: true },
  });
  if (lodgeA.createdAt >= lodgeB.createdAt) {
    await prisma.lodge.update({
      where: { id: lodgeAId },
      data: { createdAt: new Date(lodgeB.createdAt.getTime() - 60_000) },
    });
    console.log(
      "seed-second-lodge: normalised lodge A's TZ-skewed createdAt (#1627) so default-lodge resolution stays deterministic.",
    );
  }
  if ((await getDefaultLodgeId(prisma)) !== lodgeAId) {
    throw new Error(
      "seed-second-lodge: lodge B resolved as the club default even after createdAt normalisation (#1627) — refusing to mis-seed.",
    );
  }

  // Clear prior fixtures so a standalone re-run is deterministic. Cascades drop
  // guests/nights. Lodge B's own bookings go by lodgeId; the cross-lodge offer
  // (kept on lodge A) and the lodge-A roster arrival go by their fixed ids.
  await prisma.booking.deleteMany({
    where: {
      OR: [
        { lodgeId: lodgeBId },
        {
          id: {
            in: [
              CROSS_LODGE_OFFER_BOOKING_ID,
              CROSS_LODGE_OFFER_MEMBER_GUEST_BOOKING_ID,
              ROSTER_LODGE_A_BOOKING_ID,
            ],
          },
        },
      ],
    },
  });

  // 2. Rooms + active beds. Capacity for a non-default lodge comes from its
  //    configured active beds (bedAllocation is on in E2E), never the club
  //    config total, so lodge B must have real beds to be bookable.
  if ((await prisma.lodgeBed.count({ where: { room: { lodgeId: lodgeBId } } })) === 0) {
    const room = await prisma.lodgeRoom.create({
      data: { name: "Lodge B Bunk Room", sortOrder: 1, lodgeId: lodgeBId },
    });
    for (let i = 1; i <= SECOND_LODGE_BED_COUNT; i += 1) {
      await prisma.lodgeBed.create({
        data: { roomId: room.id, name: `B${i}`, sortOrder: i, active: true },
      });
    }
  }

  // 3. Seasons mirroring lodge A's active seasons (same dates + per-tier rates)
  //    so lodge B can price a stay and the cross-lodge waitlist quote works.
  const lodgeASeasons = await prisma.season.findMany({
    where: { lodgeId: lodgeAId, active: true },
    include: { membershipTypeRates: true },
  });
  for (const season of lodgeASeasons) {
    const cloneId = `e2e-lodge-b-${season.id}`;
    if (await prisma.season.findUnique({ where: { id: cloneId } })) continue;
    await prisma.season.create({
      data: {
        id: cloneId,
        name: `${season.name} (Lodge B)`,
        type: season.type,
        startDate: season.startDate,
        endDate: season.endDate,
        active: true,
        lodgeId: lodgeBId,
        // Membership-type-keyed rates authoritatively price bookings
        // (#1930, E4). The legacy boolean-keyed SeasonRate table this used to
        // clone alongside them was dropped by #2129 step 2 (Release B).
        membershipTypeRates: {
          create: season.membershipTypeRates.map((rate) => ({
            membershipTypeId: rate.membershipTypeId,
            ageTier: rate.ageTier,
            pricePerNightCents: rate.pricePerNightCents,
          })),
        },
      },
    });
  }

  // 4. Bind the demo LODGE kiosk persona to lodge B via a STAFF grant, so its
  //    kiosk session serves only lodge B (getStaffLodgeBinding → bound).
  const kiosk = await prisma.member.findFirst({
    where: { email: ROLE_PERSONAS.LODGE.email },
    select: { id: true },
  });
  if (!kiosk) {
    throw new Error(
      "LODGE role persona is missing — run prisma/demo-seed.ts before seed-second-lodge.ts",
    );
  }
  await prisma.memberLodgeAccess.upsert({
    where: {
      memberId_lodgeId_kind: {
        memberId: kiosk.id,
        lodgeId: lodgeBId,
        kind: "STAFF",
      },
    },
    update: {},
    create: { memberId: kiosk.id, lodgeId: lodgeBId, kind: "STAFF" },
  });

  const wanda = await prisma.member.findFirst({
    where: { email: WAITLISTER.email },
    select: { id: true },
  });
  if (!wanda) {
    throw new Error(
      "WAITLISTER persona is missing — run prisma/demo-seed.ts before seed-second-lodge.ts",
    );
  }

  // 5. Roster-isolation arrivals (scenario c): a PAID (operational-stay) arrival
  //    at EACH lodge on the same night. Non-member guests with distinct names so
  //    a lodge-B kiosk showing lodge A's guest would be unmistakable. PAID —
  //    not CONFIRMED — because the kiosk guest list only shows
  //    OPERATIONAL_STAY_BOOKING_STATUSES ([PAID, COMPLETED]).
  await createBookingWithGuests({
    id: ROSTER_LODGE_A_BOOKING_ID,
    memberId: wanda.id,
    lodgeId: lodgeAId,
    status: BookingStatus.PAID,
    checkIn: ROSTER_ISOLATION_WINDOW.checkIn,
    checkOut: ROSTER_ISOLATION_WINDOW.checkOut,
    guests: [{ ...ROSTER_GUEST_LODGE_A, isMember: false }],
  });
  await createBookingWithGuests({
    memberId: wanda.id,
    lodgeId: lodgeBId,
    status: BookingStatus.PAID,
    checkIn: ROSTER_ISOLATION_WINDOW.checkIn,
    checkOut: ROSTER_ISOLATION_WINDOW.checkOut,
    guests: [{ ...ROSTER_GUEST_LODGE_B, isMember: false }],
  });

  // 6. Capacity-isolation hold (scenario b): a PAID booking at lodge B that
  //    holds beds. Lodge B occupancy rises by the guest count while lodge A is
  //    untouched for the same window.
  await createBookingWithGuests({
    memberId: wanda.id,
    lodgeId: lodgeBId,
    status: BookingStatus.PAID,
    checkIn: CAPACITY_ISOLATION_WINDOW.checkIn,
    checkOut: CAPACITY_ISOLATION_WINDOW.checkOut,
    guests: Array.from({ length: CAPACITY_ISOLATION_GUEST_COUNT }, (_, i) => ({
      firstName: `Occupant${i + 1}`,
      lastName: "Lodgeb",
      isMember: false,
    })),
  });

  // Re-read an offer entry with the exact include the confirm path uses, quote
  // it at lodge B with the SAME helper the confirm re-checks with
  // (quoteWaitlistEntryAtLodge), and stamp the offered lodge + price so the
  // accept never trips OFFER_PRICE_CHANGED. Shared by both seeded offers.
  async function stampCrossLodgeOffer(offerId: string): Promise<number> {
    const entry = await prisma.booking.findUniqueOrThrow({
      where: { id: offerId },
      include: { guests: { include: { nights: true } } },
    });
    const quote = await quoteWaitlistEntryAtLodge(
      prisma,
      {
        memberId: entry.memberId,
        checkIn: entry.checkIn,
        checkOut: entry.checkOut,
        guests: entry.guests.map((guest) => ({
          ageTier: guest.ageTier,
          isMember: guest.isMember,
          memberId: guest.memberId,
          stayStart: guest.stayStart,
          stayEnd: guest.stayEnd,
          nights: guest.nights,
        })),
        hasPromoRedemption: false,
      },
      lodgeBId,
    );
    if (!quote.offerable) {
      throw new Error(
        `Cross-lodge offer ${offerId} is not priceable at lodge B (reason: ${quote.reason}) — check lodge B seasons/rates`,
      );
    }
    await prisma.booking.update({
      where: { id: offerId },
      data: {
        waitlistOfferedLodgeId: lodgeBId,
        waitlistOfferedPriceCents: quote.finalPriceCents,
        totalPriceCents: quote.finalPriceCents,
        finalPriceCents: quote.finalPriceCents,
      },
    });
    return quote.finalPriceCents;
  }

  // 7. Cross-lodge waitlist offer (scenario d, ADR-004): Wanda's WAITLIST_OFFERED
  //    entry stays on lodge A, but its active offer is for lodge B. The guest
  //    row carries NO memberId — a member booking on behalf of a non-member
  //    guest is a standard domain shape, and it exercises the create-and-cancel
  //    accept path. The member-linked composition (which #1628/#1609 used to
  //    block) is seeded separately below as scenario (e)'s regression fixture.
  const offer = await createBookingWithGuests({
    id: CROSS_LODGE_OFFER_BOOKING_ID,
    memberId: wanda.id,
    lodgeId: lodgeAId,
    status: BookingStatus.WAITLIST_OFFERED,
    checkIn: CROSS_LODGE_OFFER_WINDOW.checkIn,
    checkOut: CROSS_LODGE_OFFER_WINDOW.checkOut,
    guests: [
      {
        firstName: WAITLISTER.firstName,
        lastName: WAITLISTER.lastName,
        isMember: false,
        memberId: null,
      },
    ],
    extra: {
      waitlistPosition: 1,
      waitlistOfferedAt: new Date(),
      // Far-future expiry so the in-process expiry cron never reverts it.
      waitlistOfferExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });
  const offerPriceCents = await stampCrossLodgeOffer(offer.id);

  // 7b. #1628/#1609 regression fixture (scenario e): the same offer shape but
  //     with the guest row member-linked (Wanda herself). The Phase-2
  //     member-night guard used to trip on the entry's own WAITLIST_OFFERED
  //     booking; it now excludes the entry being replaced, so this confirm
  //     must succeed exactly like (d). Disjoint window from every other
  //     lodge-B fixture so it interacts with nothing else.
  const memberGuestOffer = await createBookingWithGuests({
    id: CROSS_LODGE_OFFER_MEMBER_GUEST_BOOKING_ID,
    memberId: wanda.id,
    lodgeId: lodgeAId,
    status: BookingStatus.WAITLIST_OFFERED,
    checkIn: CROSS_LODGE_OFFER_MEMBER_GUEST_WINDOW.checkIn,
    checkOut: CROSS_LODGE_OFFER_MEMBER_GUEST_WINDOW.checkOut,
    guests: [
      {
        firstName: WAITLISTER.firstName,
        lastName: WAITLISTER.lastName,
        isMember: true,
        memberId: wanda.id,
      },
    ],
    extra: {
      waitlistPosition: 2,
      waitlistOfferedAt: new Date(),
      waitlistOfferExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });
  await stampCrossLodgeOffer(memberGuestOffer.id);

  console.log(
    `Second lodge seeded (E2E_MULTI_LODGE): "${SECOND_LODGE.name}" ` +
      `(${SECOND_LODGE_BED_COUNT} beds, ${lodgeASeasons.length} seasons), kiosk bound, ` +
      `cross-lodge offer ${CROSS_LODGE_OFFER_BOOKING_ID} @ ${offerPriceCents}c ` +
      `(+ #1628 member-guest regression ${CROSS_LODGE_OFFER_MEMBER_GUEST_BOOKING_ID})`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
