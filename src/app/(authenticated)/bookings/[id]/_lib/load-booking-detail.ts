import { prisma } from "@/lib/prisma";

/**
 * The booking-detail READ MODEL: the one `findUnique` every section of the
 * booking page projects from (#2958). It owns nothing but the shape of the read
 * — which relations ride along and in what order — so the edit panel, the
 * history, the admin tools and the payment cards all see the same booking.
 *
 * Moved verbatim from `page.tsx`; the comments inside the `include` are the
 * ones each relation carried there.
 */
export async function loadBookingDetail(id: string) {
  const booking = await prisma.booking.findUnique({
    where: { id },
    include: {
      // Deterministic order (#2266 MED-4): the edit panel derives promo
      // beneficiary bindings and pricing rows from this list, so it must be
      // the same order the modify/modify-quote fetches use.
      guests: {
        include: { nights: { select: { stayDate: true } } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
      payment: {
        // #2350: every Payment scalar as before, plus the most recent ADDITIONAL
        // transaction so the admin panel can say when the outstanding extra was
        // raised (the summary columns only describe the latest one).
        include: {
          transactions: {
            where: { kind: "ADDITIONAL" },
            select: { createdAt: true },
            orderBy: { createdAt: "desc" },
            take: 1,
          },
        },
      },
      member: { select: { firstName: true, lastName: true } },
      lodge: { select: { name: true } },
      // Admin capacity hold (#1764): who placed it, for the admin tools card.
      adminCapacityHoldBy: { select: { firstName: true, lastName: true } },
      // Exclusive whole-lodge hold (#121): who set it, for the admin tools card.
      wholeLodgeHoldBy: { select: { firstName: true, lastName: true } },
      // "No emails" switch (#2258/#2259): who turned it on, named on the
      // admin-only control. The scalar columns come with the `include` above.
      noEmailsBy: { select: { firstName: true, lastName: true } },
      // Request-converted PENDING holds capacity (#1254); the admin hold
      // controls need the natural-holding answer to hide Release correctly.
      originBookingRequest: { select: { id: true } },
      // Cross-lodge waitlist offer (ADR-004): named on the offer card.
      waitlistOfferedLodge: { select: { name: true } },
      requestedRoom: {
        select: { id: true, name: true, active: true },
      },
      promoRedemption: {
        include: {
          promoCode: {
            select: {
              code: true,
              type: true,
              description: true,
              internal: true,
              workPartyEvent: { select: { name: true } },
            },
          },
        },
      },
      creditsFromCancellation: {
        select: {
          amountCents: true,
          description: true,
        },
      },
      modifications: {
        orderBy: { createdAt: "desc" },
      },
      refundRequests: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          reason: true,
          requestedAmountCents: true,
          approvedAmountCents: true,
          adminNotes: true,
          createdAt: true,
          reviewedAt: true,
        },
      },
      changeRequests: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          reason: true,
          adminNotes: true,
          requestedChanges: true,
          createdAt: true,
          reviewedAt: true,
        },
      },
      createdBy: {
        select: { firstName: true, lastName: true },
      },
      deletedBy: {
        select: { firstName: true, lastName: true, email: true },
      },
      adminReviewedBy: {
        select: { firstName: true, lastName: true },
      },
      // Split-booking group (#738): the member booking links to its provisional
      // non-member child(ren); the child links back to its member booking.
      parentBooking: {
        select: { id: true, status: true, finalPriceCents: true },
      },
      linkedBookings: {
        select: {
          id: true,
          status: true,
          finalPriceCents: true,
          hasNonMembers: true,
          // #1975: dates for the "Your non-member guests" section — shown only
          // when they differ from the parent's stay dates.
          checkIn: true,
          checkOut: true,
          guests: { select: { id: true } },
          // Discriminates a genuine #738 split child from a #796 group joiner
          // (joiners also carry parentBookingId but always have a join row).
          groupBookingJoin: { select: { id: true } },
        },
      },
      // Group booking the owner organises on this booking (#796+). Drives the
      // organiser management card: join code, share link, open/close and (for
      // ORGANISER_PAYS) the combined settlement.
      groupBookingAsOrganiser: {
        select: {
          joinCode: true,
          status: true,
          paymentMode: true,
          joinDeadline: true,
          maxJoiners: true,
          settlement: {
            select: { status: true, amountCents: true, paidAt: true },
          },
          joins: {
            select: {
              id: true,
              isMember: true,
              contactFirstName: true,
              contactLastName: true,
              joinerMember: { select: { firstName: true, lastName: true } },
              booking: {
                select: {
                  status: true,
                  finalPriceCents: true,
                  guests: { select: { id: true } },
                },
              },
            },
          },
        },
      },
    },
  });
  return booking;
}

/** The loaded booking, once `notFound()` has ruled out `null`. */
export type BookingDetailRecord = NonNullable<
  Awaited<ReturnType<typeof loadBookingDetail>>
>;
