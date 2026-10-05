import { prisma } from "@/lib/prisma";
import {
  netCollectedBookingSelect,
  netCollectedCaptureEvidenceSelect,
} from "@/lib/additional-ledger-gap";
import { isGroupSettlementBoundToInvoice } from "@/lib/group-settlement-invoice-binding";
import {
  BOOKING_MONEY_RECONCILIATION_SELECT,
  reconcileStoredBookingMoney,
} from "@/lib/booking-money-reconciliation-store";

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
        include: {
          nights: {
            select: {
              stayDate: true,
              priceCents: true,
              priceSource: true,
            },
          },
        },
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
          // #3811: the capture evidence Net Collected's cash rule reads, so the
          // "Non-refundable amount retained" line is that rule's figure.
          _count: netCollectedCaptureEvidenceSelect._count,
        },
      },
      // #3811 (owner decision on #3372, 3 Oct 2026): an open hand-back refund
      // comes off the retained line straight away, as it does Net Collected.
      manualRefundTasks: netCollectedBookingSelect.manualRefundTasks,
      member: { select: { firstName: true, lastName: true } },
      // #3369: the owner may be an Organisation; bookingOwner() reads both.
      organisation: { select: { name: true, email: true } },
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
          allocations: {
            select: { memberId: true, priceAdjustmentCents: true },
          },
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
      nightAdjustments: {
        select: { beneficiaryMemberId: true, amountCents: true },
      },
      creditsFromCancellation: {
        select: {
          amountCents: true,
          description: true,
          // The restore test reads both (`isCancellationCreditRestoreRow`).
          type: true,
          restoredFromBookingId: true,
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
        select: {
          id: true,
          status: true,
          finalPriceCents: true,
          // #3269: the admin confirm-pending-guests button's "will charge"
          // wording must agree with the route, which may charge a split child
          // on its parent's SetupIntent-saved card.
          payment: {
            select: {
              stripeCustomerId: true,
              stripePaymentMethodId: true,
              stripeSetupIntentId: true,
            },
          },
        },
      },
      linkedBookings: {
        select: {
          // #3278 (`INV-SSOT`): the linked child is classified by
          // `reconcileStoredBookingMoney` too, so it takes the canonical
          // projection itself rather than a hand-kept copy of it — a column
          // added to the classifier's evidence must not be able to reach this
          // read late.
          ...BOOKING_MONEY_RECONCILIATION_SELECT,
          status: true,
          hasNonMembers: true,
          // #1975: dates for the "Your non-member guests" section — shown only
          // when they differ from the parent's stay dates. `id` is this read's
          // own addition on top of the canonical guest evidence.
          guests: {
            select: {
              ...BOOKING_MONEY_RECONCILIATION_SELECT.guests.select,
              id: true,
            },
          },
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
          id: true,
          joinCode: true,
          status: true,
          paymentMode: true,
          joinDeadline: true,
          maxJoiners: true,
          settlement: {
            select: {
              id: true,
              status: true,
              amountCents: true,
              paidAt: true,
              source: true,
              // #3642: whether the bound invoice has been raised yet.
              xeroInvoiceId: true,
            },
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
                  // #3278 (`INV-SSOT`): a joiner's booking is classified by the
                  // same projection, so it reads the canonical select rather
                  // than a third copy of its columns.
                  ...BOOKING_MONEY_RECONCILIATION_SELECT,
                  status: true,
                  // #3672: a joiner of a paid organiser-pays group pays for
                  // themselves; the card must not count them as owed.
                  organiserSettled: true,
                  guests: {
                    select: {
                      ...BOOKING_MONEY_RECONCILIATION_SELECT.guests.select,
                      id: true,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  if (!booking) return null;
  // #3642: the latest CREATE row of the organiser's group invoice, so the card
  // can say whether it is being prepared, failed, was actually emailed, or
  // could not be raised at all. Read only for an Internet Banking settlement
  // still waiting on it, or one whose last request was refused.
  const settlement = booking.groupBookingAsOrganiser?.settlement ?? null;
  const groupSettlementInvoiceCreate =
    settlement &&
    (isGroupSettlementBoundToInvoice(settlement) ||
      (settlement.source === "INTERNET_BANKING" && settlement.status === "FAILED"))
      ? await prisma.xeroSyncOperation.findFirst({
          where: {
            direction: "OUTBOUND",
            entityType: "INVOICE",
            operationType: "CREATE",
            localModel: "GroupBookingSettlement",
            localId: settlement.id,
          },
          orderBy: { createdAt: "desc" },
          select: { status: true, responsePayload: true },
        })
      : null;
  return {
    ...booking,
    moneyReconciliation: reconcileStoredBookingMoney(booking),
    groupSettlementInvoiceCreate,
  };
}

/** The loaded booking, once `notFound()` has ruled out `null`. */
export type BookingDetailRecord = NonNullable<
  Awaited<ReturnType<typeof loadBookingDetail>>
>;
