import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MyBookingsList, type MyBookingItem } from "./_components/my-bookings-list";
import { MyWholeLodgeRequests } from "./_components/my-whole-lodge-requests";
import { MyExceptionRequests } from "./_components/my-exception-requests";
import { toMyWholeLodgeRequestItem } from "@/lib/member-whole-lodge-requests";
import { readMemberExceptionRequests } from "@/lib/booking-exception-request-service";
import { bookingsWithOpenFinancialReview } from "@/lib/booking-financial-review-visibility";

export default async function MyBookingsPage() {
  const session = await auth();
  if (!session) return null;

  // #2263 — the member's own whole-lodge requests. Scoped by
  // requestedByMemberId + exclusivityRequested, and projected through
  // toMyWholeLodgeRequestItem, which is the ONE place a request row is reduced
  // to something a member may see (strict allowlist + exhaustive status
  // mapping). Nothing from the row reaches the client except those fields.
  const wholeLodgeRequestRows = await prisma.bookingRequest.findMany({
    where: {
      requestedByMemberId: session.user.id,
      exclusivityRequested: true,
    },
    select: {
      id: true,
      status: true,
      checkIn: true,
      checkOut: true,
      createdAt: true,
      convertedBookingId: true,
      heldBookingId: true,
      guests: true,
    },
    orderBy: { createdAt: "desc" },
    // Bounded history: declined and withdrawn rows purge on the 90-day
    // retention clock anyway (owner decision OD-B), and the section is a
    // sidebar to My bookings, not an archive.
    take: 20,
  });

  const wholeLodgeRequests = wholeLodgeRequestRows.map((row) =>
    toMyWholeLodgeRequestItem({
      ...row,
      guestCount: Array.isArray(row.guests) ? row.guests.length : 0,
    }),
  );

  // #2562 — the member's own booking-policy exception requests, both flavours.
  // Projected by `readMemberExceptionRequests`, which is the ONE place a request
  // row is reduced to something a member may see: a strict allowlist with no slot
  // for the officer's internal note, whose column the read does not even select.
  const exceptionRequests = await readMemberExceptionRequests(session.user.id);

  const bookings = await prisma.booking.findMany({
    where: {
      deletedAt: null,
      OR: [
        { memberId: session.user.id },
        { guests: { some: { memberId: session.user.id } } },
      ],
    },
    include: {
      guests: true,
      // #796 discriminator: a group joiner also links to its organiser via
      // parentBookingId, so the list needs the join row to tell it apart from a
      // genuine #738 split child. Mirrors [id]/page.tsx's nonMemberGuestChildren
      // filter (`hasNonMembers && !groupBookingJoin`).
      groupBookingJoin: { select: { id: true } },
    },
    // Newest start date first, with a stable createdAt tiebreaker (#771).
    orderBy: [{ checkIn: "desc" }, { createdAt: "desc" }],
  });

  // Split-booking grouping (#738): a mixed party is a member booking plus a
  // linked provisional non-member booking. Label both so a family reads as one.
  const memberBookingIdsWithLinkedGuests = new Set(
    bookings
      .map((booking) => booking.parentBookingId)
      .filter((id): id is string => Boolean(id)),
  );

  /*
    #3033 (epic #2797): which of these bookings have money held for review.

    ONE batched read for the whole list, not one per card. Every booking on this
    screen shows `finalPriceCents` — which a structural edit UPDATES — so a
    booking whose adjustment is unresolved currently shows a figure that looks
    authoritative and is not the whole story. That is the "never a stale figure"
    case, and the qualifier below is what stops the number speaking for itself.
  */
  const bookingsUnderFinancialReview = await bookingsWithOpenFinancialReview(
    bookings.map((booking) => booking.id),
  );

  const items: MyBookingItem[] = bookings.map((booking) => {
    // #1975/#796: only a genuine #738 split child (a provisional non-member
    // booking) is nestable. A group joiner also carries parentBookingId but is
    // presented by the organiser group card, not nested here. Mirror the detail
    // page's discriminator exactly ([id]/page.tsx nonMemberGuestChildren:
    // `hasNonMembers && !groupBookingJoin`).
    const isNestableSplitChild =
      Boolean(booking.parentBookingId) &&
      booking.hasNonMembers &&
      !booking.groupBookingJoin;
    return {
      id: booking.id,
      checkIn: booking.checkIn.toISOString(),
      checkOut: booking.checkOut.toISOString(),
      guestCount: booking.guests.length,
      finalPriceCents: booking.finalPriceCents,
      // #3033: the price above is the post-change total, and it is real — but a
      // booking with an open review has an adjustment on top of it that nobody
      // has worked out yet, so the row must not let it read as the final word.
      financialReviewPending: bookingsUnderFinancialReview.has(booking.id),
      status: booking.status,
      // #1975: expose the parent link ONLY for a genuine split child, so the
      // list nests it as a sub-row inside its parent's card. A #796 joiner
      // (join row present) is never carried for nesting.
      parentBookingId: isNestableSplitChild ? booking.parentBookingId : null,
      // #2002: the "provisional non-member guests · linked to your member
      // booking" label must key on the SAME discriminator as nesting, not raw
      // parentBookingId. A #796 group joiner also carries parentBookingId, so
      // keying on it alone falsely labelled the member's own joiner booking as
      // a #738 split child on its own top-level row. A joiner is simply the
      // member's own booking here (its group presentation lives on the
      // organiser's card, matching [id]/page.tsx's `!groupBookingJoin` gate),
      // so it shows no special linked label. `guest-linked` (viewer is a guest
      // on someone else's booking) and `linked-parent` are unaffected.
      linkLabel:
        booking.memberId !== session.user.id
          ? "guest-linked"
          : isNestableSplitChild
            ? "provisional-child"
            : memberBookingIdsWithLinkedGuests.has(booking.id)
              ? "linked-parent"
              : null,
    };
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">My Bookings</h1>
        <Link href="/book">
          <Button>New Booking</Button>
        </Link>
      </div>

      {items.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-center">
            <p className="text-muted-foreground mb-4">You haven&apos;t made any bookings yet.</p>
            <Link href="/book">
              <Button>Book a Stay</Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <MyBookingsList bookings={items} />
      )}

      {/* Hidden entirely when the member has no requests (D3). Decided HERE
          rather than inside the component so the client bundle for it is not
          even mounted for the ordinary member who has never used the feature. */}
      {wholeLodgeRequests.length > 0 ? (
        <MyWholeLodgeRequests requests={wholeLodgeRequests} />
      ) : null}

      {/* Hidden entirely for a member who has never raised one, on the same
          reasoning as the whole-lodge section above (#2263 D3): an ordinary member
          never meets a feature they are not using, and the client bundle for it is
          not mounted for them either. */}
      {exceptionRequests.length > 0 ? (
        <MyExceptionRequests requests={exceptionRequests} />
      ) : null}
    </div>
  );
}
