/**
 * F-COMP-03: Personal Data Export
 * GET /api/member/data-export
 *
 * Returns a JSON file containing all personal data the system holds about the
 * authenticated member. Rate limited to 5 exports per day.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, rateLimiters } from "@/lib/rate-limit";
import logger from "@/lib/logger";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Rate limit by member ID (not IP), 5 exports per day
  const rl = checkRateLimit(rateLimiters.dataExport, session.user.id);
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
        phone: true,
        dateOfBirth: true,
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
      where: { memberId: session.user.id },
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
        guests: {
          select: {
            firstName: true,
            lastName: true,
            ageTier: true,
            isMember: true,
            priceCents: true,
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
        booking: { memberId: session.user.id },
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

    const exportDate = new Date().toISOString().substring(0, 10);
    const payload = {
      exportedAt: new Date().toISOString(),
      exportedBy: `${member.firstName} ${member.lastName}`,
      profile: {
        firstName: member.firstName,
        lastName: member.lastName,
        email: member.email,
        phone: member.phone ?? null,
        dateOfBirth: member.dateOfBirth
          ? member.dateOfBirth.toISOString().substring(0, 10)
          : null,
        role: member.role,
        ageTier: member.ageTier,
        active: member.active,
        joinedDate: member.joinedDate
          ? member.joinedDate.toISOString().substring(0, 10)
          : null,
        memberSince: member.createdAt.toISOString(),
      },
      bookings: bookings.map((b) => ({
        checkIn: b.checkIn.toISOString().substring(0, 10),
        checkOut: b.checkOut.toISOString().substring(0, 10),
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
          date: c.date.toISOString().substring(0, 10),
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
          date: c.date.toISOString().substring(0, 10),
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
        seasonLabel: `${s.seasonYear}/${s.seasonYear + 1}`,
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
