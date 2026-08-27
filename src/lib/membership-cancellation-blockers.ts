import type { Prisma } from "@prisma/client";
import { ACTIVE_BOOKING_STATUSES } from "@/lib/booking-status";
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import type {
  MembershipCancellationBlocker,
  MembershipCancellationBookingBlocker,
} from "@/lib/membership-cancellation-blocker-messages";
import { loadMembershipCancellationInvoiceBlockersByMemberId } from "@/lib/membership-cancellation-invoice-blockers";
import type { MembershipCancellationSubscriptionCreditPlan } from "@/lib/membership-cancellation-subscription-credit";
import { prisma } from "@/lib/prisma";

// MembershipCancellationBookingBlocker used to be re-exported here too, but
// every consumer already imports it straight from
// @/lib/membership-cancellation-blocker-messages, the module that actually
// declares it — knip 6.29+ correctly flagged the re-export specifier as dead
// (#2502). It stays imported above since loadBookingBlockersByMemberId below
// still uses it internally.
export type { MembershipCancellationBlocker };

export type MembershipCancellationBlockerClient =
  | typeof prisma
  | Prisma.TransactionClient;

export type LoadMembershipCancellationBlockersOptions = {
  /**
   * Decide the unpaid-invoice check on a live Xero answer rather than the short
   * in-process memo. The approval guard sets this; the review queue's advisory
   * panel does not (#2392).
   */
  freshInvoiceCheck?: boolean;
  /**
   * The subscription credit plans, already loaded by the caller. Passed straight
   * through to the invoice check so a caller that also needs the plans (the
   * review queue, for the shared-invoice notice) reads them once rather than
   * twice per page load (#2400 review, F8).
   */
  creditPlansByMemberId?: ReadonlyMap<
    string,
    MembershipCancellationSubscriptionCreditPlan | null
  >;
  /**
   * Whether to run the unpaid-invoice half at all (#2402).
   *
   * `"run"` (the default, and what every approval-path caller gets by omission)
   * asks Xero. `"skip"` returns the BOOKING blockers alone and makes no Xero
   * call — for the review queue rendering for an admin who cannot approve, where
   * the answer would inform no decision and would still cost the club a metered
   * API call.
   *
   * Defaulted to `"run"` deliberately: a caller that forgets the option gets the
   * full, fail-closed check rather than a quietly partial one. A `"skip"` result
   * is NOT a clean bill of health and must never be presented as one — see
   * `getAdminMembershipCancellationRequests`, which serializes
   * `invoiceCheckSkipped` alongside it so the queue can say so in words.
   */
  invoiceCheck?: "run" | "skip";
};

export function emptyMembershipCancellationBlockerMap(memberIds: readonly string[]) {
  return new Map(
    memberIds.map((memberId) => [
      memberId,
      [] as MembershipCancellationBlocker[],
    ]),
  );
}

async function loadBookingBlockersByMemberId(
  uniqueMemberIds: readonly string[],
  db: MembershipCancellationBlockerClient,
) {
  const blockersByMemberId = new Map<
    string,
    MembershipCancellationBookingBlocker[]
  >(uniqueMemberIds.map((memberId) => [memberId, []]));

  const today = await clubTodayDateOnlyInstant();
  const [ownedBookings, guestAppearances] = await Promise.all([
    db.booking.findMany({
      where: {
        memberId: { in: [...uniqueMemberIds] },
        status: { in: [...ACTIVE_BOOKING_STATUSES] },
        checkOut: { gt: today },
      },
      select: {
        id: true,
        memberId: true,
        checkIn: true,
        checkOut: true,
        status: true,
      },
      orderBy: [{ checkIn: "asc" }, { id: "asc" }],
    }),
    db.bookingGuest.findMany({
      where: {
        memberId: { in: [...uniqueMemberIds] },
        stayEnd: { gt: today },
        booking: {
          status: { in: [...ACTIVE_BOOKING_STATUSES] },
        },
      },
      select: {
        id: true,
        memberId: true,
        stayStart: true,
        stayEnd: true,
        booking: {
          select: {
            id: true,
            status: true,
            checkIn: true,
            checkOut: true,
          },
        },
      },
      orderBy: [{ stayStart: "asc" }, { id: "asc" }],
    }),
  ]);

  for (const booking of ownedBookings) {
    blockersByMemberId.get(booking.memberId)?.push({
      type: "owned_booking",
      bookingId: booking.id,
      bookingStatus: booking.status,
      checkIn: booking.checkIn.toISOString(),
      checkOut: booking.checkOut.toISOString(),
    });
  }

  for (const guest of guestAppearances) {
    if (!guest.memberId) continue;
    blockersByMemberId.get(guest.memberId)?.push({
      type: "guest_appearance",
      bookingId: guest.booking.id,
      bookingStatus: guest.booking.status,
      checkIn: guest.stayStart.toISOString(),
      checkOut: guest.stayEnd.toISOString(),
      guestAppearanceId: guest.id,
    });
  }

  return blockersByMemberId;
}

/**
 * Every reason a membership cancellation cannot be approved yet, per member.
 *
 * Two families of blocker, deliberately behind one entry point so all three call
 * sites — the review queue, the approval guard, and the post-review reload —
 * ask the identical question and merge the answers identically:
 *
 * - future bookings and guest appearances. Local, and always checked: two
 *   indexed reads against rows the queue is already looking at, costing nothing
 *   external, so there is never a reason to withhold them from anybody.
 * - unpaid Xero invoices on the member's contact, which approval would archive
 *   (#2392 — see `membership-cancellation-invoice-blockers.ts` for what counts
 *   as unpaid, when the check runs at all, and why an unknown answer blocks).
 *   This half is a LIVE, metered Xero call, and it is the ONLY half a caller may
 *   decline: `invoiceCheck: "skip"` returns the booking blockers alone (#2402).
 *   Nothing here presents a skipped check as a clean result — the map simply has
 *   fewer entries, and the caller that asked for the skip is the one that must
 *   say so.
 *
 * ## What the three call sites do NOT share
 *
 * Which MEMBERS they ask about. The approval guard asks about the one member it
 * is deciding; the queue and the post-review reload ask only about participants
 * still awaiting approval
 * (`isMembershipCancellationParticipantAwaitingApproval`), and the queue
 * additionally declines the invoice half for a viewer who cannot approve. That
 * scoping is safe only because the predicate is exactly the approval guards'
 * own preconditions — an agreement held by test, not by construction, in
 * `membership-cancellation-admin.test.ts`. If the queue is not warning about
 * something you expected, that predicate and the viewer's `membership: edit`
 * access are the two things to check first.
 *
 * `db` reaches the BOOKING half only. The invoice half deliberately reads
 * through the global client, because it also calls Xero, and this repo's rule is
 * that external provider calls stay outside database transactions — handing it a
 * `tx` would invite exactly the long-transaction-around-a-network-call shape
 * that rule exists to prevent. So `db` is "which client sees the local rows",
 * not a whole-function isolation guarantee; no caller passes a `tx` today, and
 * one that wants to should read the invoice half separately (#2392 review).
 */
export async function loadMembershipCancellationBlockersByMemberId(
  memberIds: readonly string[],
  db: MembershipCancellationBlockerClient = prisma,
  options: LoadMembershipCancellationBlockersOptions = {},
) {
  const uniqueMemberIds = [...new Set(memberIds)].filter(Boolean);
  const blockersByMemberId =
    emptyMembershipCancellationBlockerMap(uniqueMemberIds);
  if (uniqueMemberIds.length === 0) return blockersByMemberId;

  const [bookingBlockers, invoiceBlockers] = await Promise.all([
    loadBookingBlockersByMemberId(uniqueMemberIds, db),
    // #2402: the one half a caller may decline, because it is the one half that
    // costs the club a metered Xero call.
    options.invoiceCheck === "skip"
      ? Promise.resolve(
          new Map<string, MembershipCancellationBlocker[]>(),
        )
      : loadMembershipCancellationInvoiceBlockersByMemberId(uniqueMemberIds, {
          fresh: options.freshInvoiceCheck,
          creditPlansByMemberId: options.creditPlansByMemberId,
        }),
  ]);

  for (const memberId of uniqueMemberIds) {
    blockersByMemberId.set(memberId, [
      ...(bookingBlockers.get(memberId) ?? []),
      ...(invoiceBlockers.get(memberId) ?? []),
    ]);
  }

  return blockersByMemberId;
}
