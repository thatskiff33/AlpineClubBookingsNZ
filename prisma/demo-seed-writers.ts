// ---------------------------------------------------------------------------
// Demo-seed row writers, shared by `prisma/demo-seed.ts` and the load volume
// seeder `prisma/load-volume-seed.ts` (#4940, INV-SSOT). Demo members,
// bookings, settlements and guests with per-night prices share writers, so
// the volume history a load run reads has the same shape as the demo data the
// E2E suite reads.
//
// Both callers guard the database before they get here; these writers assume
// a throwaway local database and do no checking of their own.
// ---------------------------------------------------------------------------
import type { AgeTier, Prisma, PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { PASSWORD_BCRYPT_COST } from "../src/lib/password-hashing";
import { DEMO_SEED_DOMAIN } from "../src/lib/demo-seed-guard";
import { ensureMemberAccessRolesFromCompatibilityFields } from "../src/lib/member-access-role-writes";

export const DEMO_MEMBER_NIGHTLY_CENTS = 4500;

/** The one password every demo persona shares; `.env.staging.example` documents it. */
export function demoSeedPassword(
  env: { DEMO_SEED_PASSWORD?: string } = { DEMO_SEED_PASSWORD: process.env.DEMO_SEED_PASSWORD },
): string {
  return env.DEMO_SEED_PASSWORD ?? "demo1234";
}

/** Hash the demo password once per run at the app's real bcrypt cost (never lowered for speed). */
export function demoSeedPasswordHash(
  env: { DEMO_SEED_PASSWORD?: string } = { DEMO_SEED_PASSWORD: process.env.DEMO_SEED_PASSWORD },
): string {
  return bcrypt.hashSync(demoSeedPassword(env), PASSWORD_BCRYPT_COST);
}

// Date-only helper (schema uses @db.Date for most date columns).
export function demoDate(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}

// Nights actually slept = [checkIn, checkOut) — checkout day is not a night.
export function demoNightsBetween(checkIn: string, checkOut: string): string[] {
  const out: string[] = [];
  const cur = demoDate(checkIn);
  const end = demoDate(checkOut);
  while (cur < end) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/** Booking shell used by demo fixtures and the capacity-planned volume history. */
export function createDemoBooking(
  db: PrismaClient,
  data: Omit<Prisma.BookingUncheckedCreateInput, "finalPriceCents"> & { finalPriceCents?: number },
) {
  return db.booking.create({
    data: { ...data, finalPriceCents: data.finalPriceCents ?? data.totalPriceCents },
  });
}

/** The demo's aggregate Payment and its matching PRIMARY settlement evidence. */
export async function createDemoPrimaryPayment(
  db: PrismaClient,
  data: Prisma.PaymentUncheckedCreateInput,
  transactionExtra: Pick<Prisma.PaymentTransactionUncheckedCreateInput, "reason"> = {},
) {
  const payment = await db.payment.create({ data });
  const transaction = await db.paymentTransaction.create({
    data: {
      paymentId: payment.id,
      kind: "PRIMARY",
      source: payment.source,
      amountCents: payment.amountCents,
      status: payment.status,
      refundedAmountCents: payment.refundedAmountCents,
      stripePaymentIntentId: payment.stripePaymentIntentId,
      reference: payment.reference,
      ...transactionExtra,
    },
  });
  return { payment, transaction };
}

/** A synthetic successful card refund; no provider is contacted. */
export function createDemoPaymentRefund(
  db: PrismaClient,
  data: Omit<Prisma.PaymentRefundUncheckedCreateInput, "status">,
) {
  return db.paymentRefund.create({ data: { ...data, status: "succeeded" } });
}

/** The cancellation credit fixture shared by demo and volume history. */
export function createDemoCancellationCredit(
  db: PrismaClient,
  data: Pick<Prisma.MemberCreditUncheckedCreateInput, "memberId" | "amountCents" | "description" | "sourceBookingId">,
) {
  return db.memberCredit.create({ data: { ...data, type: "CANCELLATION_REFUND" } });
}

export async function createDemoMember(
  db: PrismaClient,
  passwordHash: string,
  local: string,
  firstName: string,
  lastName: string,
  extra: Partial<Prisma.MemberUncheckedCreateInput> = {},
) {
  const member = await db.member.create({
    data: {
      email: `${local}@${DEMO_SEED_DOMAIN}`,
      passwordHash,
      firstName,
      lastName,
      role: "USER",
      ageTier: "ADULT",
      active: true,
      canLogin: true,
      emailVerified: true,
      forcePasswordChange: false,
      joinedDate: demoDate("2024-05-01"),
      ...extra,
    },
  });
  await ensureMemberAccessRolesFromCompatibilityFields(db, {
    memberId: member.id,
    role: member.role,
    financeAccessLevel: member.financeAccessLevel,
    canLogin: member.canLogin,
  });
  return member;
}

export async function addDemoGuest(
  db: PrismaClient,
  bookingId: string,
  g: {
    firstName: string;
    lastName: string;
    ageTier: AgeTier;
    isMember?: boolean;
    memberId?: string | null;
    arrivedAt?: Date | null;
    departedAt?: Date | null;
  },
  checkIn: string,
  checkOut: string,
  nightlyCents: number,
) {
  const nights = demoNightsBetween(checkIn, checkOut);
  const guest = await db.bookingGuest.create({
    data: {
      bookingId,
      firstName: g.firstName,
      lastName: g.lastName,
      ageTier: g.ageTier,
      isMember: g.isMember ?? false,
      memberId: g.memberId ?? null,
      stayStart: demoDate(checkIn),
      stayEnd: demoDate(checkOut),
      priceCents: nightlyCents * nights.length,
      arrivedAt: g.arrivedAt ?? null,
      departedAt: g.departedAt ?? null,
    },
  });
  for (const night of nights) {
    await db.bookingGuestNight.create({
      data: {
        bookingGuestId: guest.id,
        stayDate: demoDate(night),
        priceCents: nightlyCents,
        priceSource: "SOLD",
      },
    });
  }
  return guest;
}
