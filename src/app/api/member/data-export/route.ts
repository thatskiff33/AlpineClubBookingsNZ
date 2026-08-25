/**
 * F-COMP-03: Personal Data Export
 * GET /api/member/data-export
 *
 * Returns a JSON file containing all personal data the system holds about the
 * authenticated member. Rate limited to 5 exports per day.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, rateLimiters } from "@/lib/rate-limit";
import logger from "@/lib/logger";
import { formatDateOnly } from "@/lib/date-only";
import { clubTime } from "@/lib/club-time/server";
import { seasonSelectLabel } from "@/lib/season-label";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  // Rate limit by member ID (not IP), 5 exports per day
  const rl = await checkRateLimit(rateLimiters.dataExport, session.user.id);
  if (!rl.success) {
    const retryAfter = Math.ceil((rl.resetAt - Date.now()) / 1000);
    return NextResponse.json(
      { error: "Too many requests. You may export your data up to 5 times per day." },
      {
        status: 429,
        headers: {
          "Retry-After": String(retryAfter),
          "X-RateLimit-Limit": String(rl.limit),
          "X-RateLimit-Remaining": "0",
        },
      }
    );
  }

  try {
    const member = await prisma.member.findUnique({
      where: { id: session.user.id },
      select: {
        firstName: true,
        lastName: true,
        email: true,
        phoneCountryCode: true,
        phoneAreaCode: true,
        phoneNumber: true,
        dateOfBirth: true,
        streetAddressLine1: true,
        streetAddressLine2: true,
        streetCity: true,
        streetRegion: true,
        streetPostalCode: true,
        streetCountry: true,
        postalAddressLine1: true,
        postalAddressLine2: true,
        postalCity: true,
        postalRegion: true,
        postalPostalCode: true,
        postalCountry: true,
        role: true,
        ageTier: true,
        active: true,
        joinedDate: true,
        createdAt: true,
      },
    });

    if (!member) {
      return NextResponse.json({ error: "Member not found" }, { status: 404 });
    }

    // Bookings with guests, payment, and promo redemption
    const bookings = await prisma.booking.findMany({
      where: { memberId: session.user.id, deletedAt: null },
      orderBy: { checkIn: "desc" },
      select: {
        checkIn: true,
        checkOut: true,
        status: true,
        totalPriceCents: true,
        discountCents: true,
        finalPriceCents: true,
        hasNonMembers: true,
        nonMemberHoldUntil: true,
        notes: true,
        createdAt: true,
        // DELIBERATELY NOT CONSENT-FILTERED (owner decision D-12, #2307).
        //
        // D-12 keeps an unconsented guest off every OPERATIONAL surface — the
        // kiosk, the roster, bed allocation, the arrival emails, the wall. A
        // data-subject export is not one: it is this member's own record of
        // their own bookings, and a row we are holding about them (including one
        // still awaiting their guest's consent, which is holding a bed under
        // D-4) belongs in it. Hiding it would make the export a summary rather
        // than a disclosure.
        //
        // `consentStatus` is exported for the same reason: the honest answer to
        // "what do you hold about me" includes WHICH state each guest row is in,
        // not just that it exists.
        guests: {
          select: {
            firstName: true,
            lastName: true,
            ageTier: true,
            isMember: true,
            priceCents: true,
            consentStatus: true,
          },
        },
        payment: {
          select: {
            amountCents: true,
            status: true,
            refundedAmountCents: true,
            createdAt: true,
          },
        },
        promoRedemption: {
          select: {
            discountCents: true,
            createdAt: true,
          },
        },
      },
    });

    // Chore assignments (via bookings)
    const choreAssignments = await prisma.choreAssignment.findMany({
      where: {
        booking: { memberId: session.user.id, deletedAt: null },
        bookingGuestId: null, // assignments linked to the booking (not a specific guest)
      },
      select: {
        date: true,
        status: true,
        completedAt: true,
        createdAt: true,
        choreTemplate: {
          select: { name: true, description: true },
        },
        bookingGuest: {
          select: { firstName: true, lastName: true },
        },
      },
      orderBy: { date: "desc" },
    });

    // Also get chore assignments linked to this member's guest appearances
    const guestChoreAssignments = await prisma.choreAssignment.findMany({
      where: {
        bookingGuest: { memberId: session.user.id },
        booking: { deletedAt: null },
      },
      select: {
        date: true,
        status: true,
        completedAt: true,
        createdAt: true,
        choreTemplate: {
          select: { name: true, description: true },
        },
        bookingGuest: {
          select: { firstName: true, lastName: true },
        },
      },
      orderBy: { date: "desc" },
    });

    // Subscriptions
    const subscriptions = await prisma.memberSubscription.findMany({
      where: { memberId: session.user.id },
      orderBy: { seasonYear: "desc" },
      select: {
        seasonYear: true,
        status: true,
        paidAt: true,
        createdAt: true,
      },
    });

    // Audit log entries where member is actor or target
    const auditEntries = await prisma.auditLog.findMany({
      where: {
        OR: [
          { memberId: session.user.id },
          { targetId: session.user.id },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 500, // Cap at 500 entries to keep export manageable
      select: {
        action: true,
        details: true,
        createdAt: true,
      },
    });

    // CT-4 (#2870): the CLUB's calendar day, from the persisted
    // ClubTimeSettings zone and not the container's TZ (INV-CONFIG-002).
    const exportDate = (await clubTime()).today();
    const payload = {
      exportedAt: new Date().toISOString(),
      exportedBy: `${member.firstName} ${member.lastName}`,
      profile: {
        firstName: member.firstName,
        lastName: member.lastName,
        email: member.email,
        phoneCountryCode: member.phoneCountryCode ?? null,
        phoneAreaCode: member.phoneAreaCode ?? null,
        phoneNumber: member.phoneNumber ?? null,
        dateOfBirth: member.dateOfBirth
          ? formatDateOnly(member.dateOfBirth)
          : null,
        role: member.role,
        ageTier: member.ageTier,
        active: member.active,
        joinedDate: member.joinedDate
          ? formatDateOnly(member.joinedDate)
          : null,
        memberSince: member.createdAt.toISOString(),
        streetAddress: {
          addressLine1: member.streetAddressLine1 ?? null,
          addressLine2: member.streetAddressLine2 ?? null,
          city: member.streetCity ?? null,
          region: member.streetRegion ?? null,
          postalCode: member.streetPostalCode ?? null,
          country: member.streetCountry ?? null,
        },
        postalAddress: {
          addressLine1: member.postalAddressLine1 ?? null,
          addressLine2: member.postalAddressLine2 ?? null,
          city: member.postalCity ?? null,
          region: member.postalRegion ?? null,
          postalCode: member.postalPostalCode ?? null,
          country: member.postalCountry ?? null,
        },
      },
      bookings: bookings.map((b) => ({
        checkIn: formatDateOnly(b.checkIn),
        checkOut: formatDateOnly(b.checkOut),
        status: b.status,
        totalPriceCents: b.totalPriceCents,
        discountCents: b.discountCents,
        finalPriceCents: b.finalPriceCents,
        hasNonMembers: b.hasNonMembers,
        nonMemberHoldUntil: b.nonMemberHoldUntil
          ? b.nonMemberHoldUntil.toISOString()
          : null,
        notes: b.notes ?? null,
        createdAt: b.createdAt.toISOString(),
        guests: b.guests.map((g) => ({
          firstName: g.firstName,
          lastName: g.lastName,
          ageTier: g.ageTier,
          isMember: g.isMember,
          priceCents: g.priceCents,
          // #2307: null for every ordinary guest — a non-member, a family-scope
          // add, or any row written before member guests existed. A value means
          // the row is a cross-family member guest and names where its consent
          // stands.
          consentStatus: g.consentStatus ?? null,
        })),
        payment: b.payment
          ? {
              amountCents: b.payment.amountCents,
              status: b.payment.status,
              refundedAmountCents: b.payment.refundedAmountCents,
              createdAt: b.payment.createdAt.toISOString(),
            }
          : null,
        promoDiscount: b.promoRedemption
          ? {
              discountCents: b.promoRedemption.discountCents,
              appliedAt: b.promoRedemption.createdAt.toISOString(),
            }
          : null,
      })),
      choreAssignments: [
        ...choreAssignments.map((c) => ({
          date: formatDateOnly(c.date),
          choreName: c.choreTemplate.name,
          choreDescription: c.choreTemplate.description ?? null,
          assignedTo: c.bookingGuest
            ? `${c.bookingGuest.firstName} ${c.bookingGuest.lastName}`
            : "You",
          status: c.status,
          completedAt: c.completedAt ? c.completedAt.toISOString() : null,
          createdAt: c.createdAt.toISOString(),
        })),
        ...guestChoreAssignments.map((c) => ({
          date: formatDateOnly(c.date),
          choreName: c.choreTemplate.name,
          choreDescription: c.choreTemplate.description ?? null,
          assignedTo: c.bookingGuest
            ? `${c.bookingGuest.firstName} ${c.bookingGuest.lastName}`
            : "You",
          status: c.status,
          completedAt: c.completedAt ? c.completedAt.toISOString() : null,
          createdAt: c.createdAt.toISOString(),
        })),
      ],
      subscriptions: subscriptions.map((s) => ({
        seasonYear: s.seasonYear,
        seasonLabel: seasonSelectLabel(s.seasonYear),
        status: s.status,
        paidAt: s.paidAt ? s.paidAt.toISOString() : null,
        createdAt: s.createdAt.toISOString(),
      })),
      auditLog: auditEntries.map((a) => ({
        action: a.action,
        details: a.details ?? null,
        createdAt: a.createdAt.toISOString(),
      })),
    };

    const filename = `tac-my-data-${exportDate}.json`;
    const json = JSON.stringify(payload, null, 2);

    return new Response(json, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    logger.error({ err, memberId: session.user.id }, "Data export failed");
    return NextResponse.json({ error: "Failed to generate data export" }, { status: 500 });
  }
}
