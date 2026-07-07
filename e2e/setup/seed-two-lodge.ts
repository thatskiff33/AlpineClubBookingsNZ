// Two-lodge E2E provisioning (#1568). Run by scripts/e2e-stack.sh AFTER the
// demo + base seeds when E2E_TWO_LODGE=1, so the advisory two-lodge Playwright
// project (e2e/two-lodge/*) has a genuinely bookable second lodge plus the
// fixtures its scenarios assert on. It is NOT part of the default single-lodge
// blocking suite and never runs against the standard stack.
//
// Prerequisite: the second demo lodge must already exist (DEMO_SECOND_LODGE=1
// creates West Ridge Hut + rooms + beds in prisma/demo-seed.ts). This step then
// layers on the pieces that make the lodge usable and the scenarios
// deterministic — none of which belong in the demo dataset:
//
//   1. West Ridge seasons + per-tier rates, so /book, the availability API and
//      the cross-lodge waitlist quote can price a stay there (the demo block
//      seeds only fixed-price bookings, so West Ridge is otherwise unpriceable).
//   2. A LODGE kiosk account bound to West Ridge via a single STAFF
//      MemberLodgeAccess grant (scenario 3c).
//   3. One PAID booking at the default lodge and one at West Ridge on the SAME
//      night, for the per-lodge capacity/roster isolation assertions (3a/3b/3c).
//   4. Two cross-lodge WAITLIST_OFFERED entries owned by Wanda: a non-member
//      guest (3d, can pass today) and a self member-guest (3e, the #1609
//      expected-fail).
//
// Idempotent: seasons/grant upsert on deterministic keys and every booking uses
// a deterministic id that is skipped if already present, so a re-run against the
// same database is a no-op rather than a duplicate.
import { type AgeTier, PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { clubConfig } from "../../src/config/club";
import { ensureAccessRoleDefinitions } from "../../src/lib/access-role-definitions";
import { ensureMemberAccessRoles } from "../../src/lib/member-access-role-writes";
import { getDefaultLodgeId } from "../../src/lib/lodges";
import { createPrismaPgAdapter } from "../../src/lib/prisma-adapter";
import {
  CROSS_LODGE_OFFER_MEMBER_ID,
  CROSS_LODGE_OFFER_MEMBER_WINDOW,
  CROSS_LODGE_OFFER_NONMEMBER_GUEST,
  CROSS_LODGE_OFFER_NONMEMBER_ID,
  CROSS_LODGE_OFFER_NONMEMBER_WINDOW,
  CROSS_LODGE_STALE_OFFER_PRICE_CENTS,
  LODGE_A_ISOLATION_GUEST,
  LODGE_A_ISOLATION_GUEST_COUNT,
  TWO_LODGE_ISOLATION_WINDOW,
  WAITLISTER,
  WEST_RIDGE_ISOLATION_GUEST,
  WEST_RIDGE_ISOLATION_GUEST_COUNT,
  WEST_RIDGE_KIOSK,
  WEST_RIDGE_SLUG,
} from "../../prisma/e2e-fixtures";

const prisma = new PrismaClient({ adapter: createPrismaPgAdapter() });

const DEMO_PASSWORD = process.env.DEMO_SEED_PASSWORD ?? "demo1234";
const PWHASH = bcrypt.hashSync(DEMO_PASSWORD, 12);
const PROFILE_CONFIRMED_AT = new Date("2026-01-05T00:00:00.000Z");
const NOMINAL_NIGHTLY_CENTS = 3000;

function d(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}

function nightsBetween(checkIn: string, checkOut: string): string[] {
  const out: string[] = [];
  const cur = d(checkIn);
  const end = d(checkOut);
  while (cur < end) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

// Rates for every configured age tier, mirroring prisma/seed.ts so West Ridge
// prices exactly like the default lodge and the cross-lodge quote is real.
function ratesForSeason(season: "winter" | "summer") {
  return clubConfig.ageTiers.flatMap((tier) => [
    {
      ageTier: tier.id as AgeTier,
      isMember: true,
      pricePerNightCents: tier.nightlyRates[season].memberCents,
    },
    {
      ageTier: tier.id as AgeTier,
      isMember: false,
      pricePerNightCents: tier.nightlyRates[season].nonMemberCents,
    },
  ]);
}

async function upsertWestRidgeSeason(
  id: string,
  name: string,
  type: "WINTER" | "SUMMER",
  startDate: string,
  endDate: string,
  season: "winter" | "summer",
  lodgeId: string,
): Promise<void> {
  await prisma.season.upsert({
    where: { id },
    update: {},
    create: {
      id,
      name,
      type,
      startDate: d(startDate),
      endDate: d(endDate),
      active: true,
      lodgeId,
    },
  });
  for (const rate of ratesForSeason(season)) {
    await prisma.seasonRate.upsert({
      where: {
        seasonId_ageTier_isMember: {
          seasonId: id,
          ageTier: rate.ageTier,
          isMember: rate.isMember,
        },
      },
      update: {},
      create: { seasonId: id, ...rate },
    });
  }
}

async function findMemberByEmailOrThrow(email: string): Promise<{ id: string }> {
  const member = await prisma.member.findFirst({
    where: { email },
    select: { id: true },
  });
  if (!member) {
    throw new Error(
      `seed-two-lodge: expected member ${email} to exist. Run the demo + base seeds first.`,
    );
  }
  return member;
}

async function createNonLoginOwner(
  local: string,
  firstName: string,
  lastName: string,
): Promise<{ id: string }> {
  const email = `${local}@${WAITLISTER.email.split("@")[1]}`;
  const existing = await prisma.member.findFirst({
    where: { email },
    select: { id: true },
  });
  if (existing) return existing;
  return prisma.member.create({
    data: {
      email,
      passwordHash: PWHASH,
      firstName,
      lastName,
      role: "USER",
      ageTier: "ADULT",
      active: true,
      canLogin: false,
      emailVerified: true,
      forcePasswordChange: false,
    },
    select: { id: true },
  });
}

async function addGuest(
  bookingId: string,
  g: {
    firstName: string;
    lastName: string;
    ageTier: AgeTier;
    isMember?: boolean;
    memberId?: string | null;
  },
  checkIn: string,
  checkOut: string,
  nightlyCents: number,
): Promise<void> {
  const nights = nightsBetween(checkIn, checkOut);
  const guest = await prisma.bookingGuest.create({
    data: {
      bookingId,
      firstName: g.firstName,
      lastName: g.lastName,
      ageTier: g.ageTier,
      isMember: g.isMember ?? false,
      memberId: g.memberId ?? null,
      stayStart: d(checkIn),
      stayEnd: d(checkOut),
      priceCents: nightlyCents * nights.length,
    },
  });
  for (const night of nights) {
    await prisma.bookingGuestNight.create({
      data: {
        bookingGuestId: guest.id,
        stayDate: d(night),
        priceCents: nightlyCents,
      },
    });
  }
}

async function bookingExists(id: string): Promise<boolean> {
  const existing = await prisma.booking.findUnique({
    where: { id },
    select: { id: true },
  });
  return existing !== null;
}

// A PAID (capacity-holding + operational) booking with `count` guests; the
// first guest carries the named identity the roster assertion looks for, the
// rest are anonymous fillers so the per-lodge occupancy count is exact.
async function seedIsolationBooking(
  id: string,
  ownerId: string,
  lodgeId: string,
  namedGuest: { firstName: string; lastName: string },
  count: number,
): Promise<void> {
  if (await bookingExists(id)) return;
  const { checkIn, checkOut } = TWO_LODGE_ISOLATION_WINDOW;
  const nights = nightsBetween(checkIn, checkOut).length;
  const total = NOMINAL_NIGHTLY_CENTS * nights * count;
  await prisma.booking.create({
    data: {
      id,
      memberId: ownerId,
      checkIn: d(checkIn),
      checkOut: d(checkOut),
      status: "PAID",
      totalPriceCents: total,
      finalPriceCents: total,
      lodgeId,
    },
  });
  await addGuest(
    id,
    { ...namedGuest, ageTier: "ADULT", isMember: false },
    checkIn,
    checkOut,
    NOMINAL_NIGHTLY_CENTS,
  );
  for (let i = 1; i < count; i += 1) {
    await addGuest(
      id,
      { firstName: "Filler", lastName: `Guest${i}`, ageTier: "ADULT", isMember: false },
      checkIn,
      checkOut,
      NOMINAL_NIGHTLY_CENTS,
    );
  }
}

// A WAITLIST_OFFERED entry whose HOME lodge is the default lodge, offered to
// West Ridge (waitlistOfferedLodgeId). The stored offer price is deliberately
// stale so the first confirm returns OFFER_PRICE_CHANGED and refreshes it.
async function seedCrossLodgeOffer(
  id: string,
  ownerId: string,
  homeLodgeId: string,
  offeredLodgeId: string,
  window: { checkIn: string; checkOut: string },
  guest: {
    firstName: string;
    lastName: string;
    isMember: boolean;
    memberId?: string | null;
  },
): Promise<void> {
  if (await bookingExists(id)) return;
  const nights = nightsBetween(window.checkIn, window.checkOut).length;
  const nominal = NOMINAL_NIGHTLY_CENTS * nights;
  await prisma.booking.create({
    data: {
      id,
      memberId: ownerId,
      checkIn: d(window.checkIn),
      checkOut: d(window.checkOut),
      status: "WAITLIST_OFFERED",
      waitlistPosition: 1,
      waitlistOfferedAt: new Date(),
      waitlistOfferExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      waitlistOfferedLodgeId: offeredLodgeId,
      waitlistOfferedPriceCents: CROSS_LODGE_STALE_OFFER_PRICE_CENTS,
      totalPriceCents: nominal,
      finalPriceCents: nominal,
      lodgeId: homeLodgeId,
    },
  });
  await addGuest(
    id,
    { ...guest, ageTier: "ADULT" },
    window.checkIn,
    window.checkOut,
    NOMINAL_NIGHTLY_CENTS,
  );
}

async function main(): Promise<void> {
  const westRidge = await prisma.lodge.findFirst({
    where: { slug: WEST_RIDGE_SLUG },
    select: { id: true, active: true, createdAt: true },
  });
  if (!westRidge) {
    throw new Error(
      `seed-two-lodge: West Ridge Hut (slug ${WEST_RIDGE_SLUG}) not found. ` +
        "Run the demo seed with DEMO_SECOND_LODGE=1 before this step.",
    );
  }
  const westRidgeId = westRidge.id;

  // The migration-created default lodge (fixed slug "lodge") writes createdAt
  // with the database's CURRENT_TIMESTAMP — under the staging stack's
  // PGTZ=Pacific/Auckland that renders NZ local time into the naive timestamp
  // column, ~12h AHEAD of the UTC timestamps Prisma seeds write. West Ridge
  // then sorts "earlier" and getDefaultLodgeId (earliest active) resolves the
  // WRONG lodge — which would skew every default-lodge fallback the app makes,
  // not just this seed. Normalise the skew so the original lodge is
  // unambiguously the default, then re-assert via the product resolver.
  const originalLodge = await prisma.lodge.findFirst({
    where: { slug: "lodge" },
    select: { id: true, createdAt: true },
  });
  if (!originalLodge) {
    throw new Error(
      'seed-two-lodge: the migration-created default lodge (slug "lodge") not found.',
    );
  }
  if (originalLodge.createdAt >= westRidge.createdAt) {
    await prisma.lodge.update({
      where: { id: originalLodge.id },
      data: {
        createdAt: new Date(westRidge.createdAt.getTime() - 60_000),
      },
    });
    console.log(
      "seed-two-lodge: normalised the default lodge's createdAt (DB-local " +
        "CURRENT_TIMESTAMP vs client-UTC skew) so default-lodge resolution is " +
        "deterministic.",
    );
  }
  const defaultLodgeId = await getDefaultLodgeId(prisma);
  if (westRidgeId === defaultLodgeId) {
    throw new Error(
      "seed-two-lodge: West Ridge resolved to the default lodge — the two lodges must be distinct.",
    );
  }

  await ensureAccessRoleDefinitions(prisma);

  // 1. West Ridge seasons + rates (Winter 2026 + Summer 2026-27, matching the
  //    default lodge's seeded ranges) so the lodge is priceable.
  await upsertWestRidgeSeason(
    "e2e-west-ridge-winter-2026",
    "Winter 2026 (West Ridge)",
    "WINTER",
    "2026-06-01",
    "2026-09-30",
    "winter",
    westRidgeId,
  );
  await upsertWestRidgeSeason(
    "e2e-west-ridge-summer-2026",
    "Summer 2026-27 (West Ridge)",
    "SUMMER",
    "2026-11-01",
    "2027-03-31",
    "summer",
    westRidgeId,
  );

  // 2. West Ridge kiosk account: LODGE access + a single STAFF grant binding it
  //    to West Ridge (getStaffLodgeBinding → "bound").
  let kiosk = await prisma.member.findFirst({
    where: { email: WEST_RIDGE_KIOSK.email },
    select: { id: true },
  });
  if (!kiosk) {
    kiosk = await prisma.member.create({
      data: {
        email: WEST_RIDGE_KIOSK.email,
        passwordHash: PWHASH,
        firstName: WEST_RIDGE_KIOSK.firstName,
        lastName: WEST_RIDGE_KIOSK.lastName,
        role: "LODGE",
        ageTier: "ADULT",
        active: true,
        canLogin: true,
        emailVerified: true,
        forcePasswordChange: false,
        profileCompletedAt: PROFILE_CONFIRMED_AT,
        detailsConfirmedAt: PROFILE_CONFIRMED_AT,
        onboardingConfirmedAt: PROFILE_CONFIRMED_AT,
      },
      select: { id: true },
    });
    await prisma.member.update({
      where: { id: kiosk.id },
      data: { detailsConfirmedByMemberId: kiosk.id },
    });
  }
  await ensureMemberAccessRoles(prisma, {
    memberId: kiosk.id,
    roles: ["LODGE"],
    canLogin: true,
  });
  await prisma.memberLodgeAccess.upsert({
    where: {
      memberId_lodgeId_kind: {
        memberId: kiosk.id,
        lodgeId: westRidgeId,
        kind: "STAFF",
      },
    },
    update: {},
    create: { memberId: kiosk.id, lodgeId: westRidgeId, kind: "STAFF" },
  });

  // 3. Per-lodge isolation bookings on the same night.
  const lodgeAOwner = await createNonLoginOwner(
    "two-lodge-a-owner",
    "Iso",
    "OwnerA",
  );
  const westRidgeOwner = await createNonLoginOwner(
    "two-lodge-b-owner",
    "Iso",
    "OwnerB",
  );
  await seedIsolationBooking(
    "e2e-two-lodge-iso-a",
    lodgeAOwner.id,
    defaultLodgeId,
    LODGE_A_ISOLATION_GUEST,
    LODGE_A_ISOLATION_GUEST_COUNT,
  );
  await seedIsolationBooking(
    "e2e-two-lodge-iso-b",
    westRidgeOwner.id,
    westRidgeId,
    WEST_RIDGE_ISOLATION_GUEST,
    WEST_RIDGE_ISOLATION_GUEST_COUNT,
  );

  // 4. Cross-lodge waitlist offers owned by Wanda.
  const wanda = await findMemberByEmailOrThrow(WAITLISTER.email);
  await seedCrossLodgeOffer(
    CROSS_LODGE_OFFER_NONMEMBER_ID,
    wanda.id,
    defaultLodgeId,
    westRidgeId,
    CROSS_LODGE_OFFER_NONMEMBER_WINDOW,
    { ...CROSS_LODGE_OFFER_NONMEMBER_GUEST, isMember: false },
  );
  await seedCrossLodgeOffer(
    CROSS_LODGE_OFFER_MEMBER_ID,
    wanda.id,
    defaultLodgeId,
    westRidgeId,
    CROSS_LODGE_OFFER_MEMBER_WINDOW,
    {
      firstName: WAITLISTER.firstName,
      lastName: WAITLISTER.lastName,
      isMember: true,
      memberId: wanda.id,
    },
  );

  console.log(
    `Two-lodge E2E fixtures seeded: West Ridge seasons/rates, kiosk ${WEST_RIDGE_KIOSK.email} ` +
      `bound to West Ridge, isolation bookings (${LODGE_A_ISOLATION_GUEST_COUNT} @ default / ` +
      `${WEST_RIDGE_ISOLATION_GUEST_COUNT} @ West Ridge), and 2 cross-lodge waitlist offers.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
