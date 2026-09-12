import { NextRequest, NextResponse } from "next/server";
import { BookingStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { hasAdminAccess } from "@/lib/access-roles";
import { issueSplitGuestPaymentLink } from "@/lib/payment-link-split-guest";
import logger from "@/lib/logger";

/**
 * Split-booking guest-portion payment link, on demand (#1967).
 *
 * The booker calls this from the booking-detail page when they pay their own
 * place by Internet Banking and their non-member guests are held in a linked
 * provisional child: with no card on file, the guest portion cannot be
 * auto-charged at settlement, so this emails the member a secure `/pay/<token>`
 * link for each provisional child. It is a true send/RE-SEND: an existing
 * active link is revoked and replaced (raw tokens are never stored, so a fresh
 * mint is the only way to re-send), while a link minted within the last minute
 * short-circuits to `justSent` — so a double click (or a click racing the
 * settlement cron) never fans out duplicate emails or leaves two live tokens.
 *
 * `id` is the PARENT (member) booking id; links are issued for its linked
 * genuine split children (#738) — PENDING, non-member, and NOT #796 group
 * joiners (joiners also carry parentBookingId but always have a
 * GroupBookingJoin row; their payment flows are separate).
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { id } = await params;
  const booking = await prisma.booking.findUnique({
    where: { id },
    select: {
      memberId: true,
      deletedAt: true,
      linkedBookings: {
        where: {
          status: BookingStatus.PENDING,
          hasNonMembers: true,
          // Genuine split children only — group joiners are a different flow.
          groupBookingJoin: { is: null },
        },
        select: { id: true },
      },
    },
  });

  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }
  // #2258: the caller may be the BOOKER, not an officer. Remember which, so a
  // withheld outcome discloses its cause to an admin and never to a member.
  const isAdmin = hasAdminAccess(session.user);
  if (booking.memberId !== session.user.id && !isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // #2674 (INV-ADDPAY-031): the deletion check sits AFTER the authorisation
  // check, not folded into the not-found branch above it. Checked first — which
  // is how this route was written — a caller with no claim on the booking got
  // 404 for a deleted booking and 403 for a live one, so an id whose existence
  // they could otherwise establish (a booking they were a guest on, a shared
  // URL) flipped 403 -> 404 the moment an admin deleted it. The body stays
  // BYTE-IDENTICAL to the not-found branch so a deleted booking and a
  // nonexistent one are indistinguishable to a caller who IS authorised.
  //
  // 404 for every role, with no Full Admin exemption: that exemption belongs to
  // record-VIEWING surfaces like `bookings/[id]/page.tsx`, and this is a write
  // (it mints and emails live payment tokens).
  if (booking.deletedAt) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  const children = booking.linkedBookings;
  if (children.length === 0) {
    return NextResponse.json(
      { error: "This booking has no provisional guests to send a payment link for." },
      { status: 400 }
    );
  }

  let sent = 0;
  let justSent = 0;
  let suppressed = 0;
  // #2258: deliberately withheld is its own count. Folding it into `sent` would
  // tell the admin the member has the link; folding it into `suppressed` would
  // blame the member's address for a choice the club made.
  let withheld = 0;
  // #2258: the switch could not be READ, so the send failed closed. Separate
  // again — a transient database fault must never be reported as an
  // undeliverable address.
  let transientFailure = 0;
  for (const child of children) {
    try {
      const result = await issueSplitGuestPaymentLink(child.id);
      if (result.outcome === "sent") sent += 1;
      else if (result.outcome === "just_sent") justSent += 1;
      else if (result.outcome === "suppressed") suppressed += 1;
      else if (result.outcome === "withheld") withheld += 1;
      else if (result.outcome === "transient_failure") transientFailure += 1;
    } catch (err) {
      logger.error(
        { err, bookingId: child.id, parentBookingId: id },
        "Failed to issue split guest payment link"
      );
      return NextResponse.json(
        { error: "Unable to send the payment link right now. Please try again." },
        { status: 500 }
      );
    }
  }

  if (withheld > 0 && sent === 0 && justSent === 0) {
    // #2258: nothing was minted or sent because this booking is set to receive
    // no email. Not a 502 — nothing is broken and retrying changes nothing.
    //
    // THIS ROUTE IS NOT ADMIN-ONLY: the booker calls it for their own booking
    // (see the authorisation above), and the only client renders `error`
    // verbatim. So the cause is disclosed ONLY to an admin. A member gets the
    // same cause-free wording the /pay refresh page uses, because naming the
    // switch would both reveal an internal admin control and invite them to ask
    // for it to be changed.
    return NextResponse.json(
      {
        error: isAdmin
          ? "This booking is set to send no emails, so no payment link was sent. Turn emails back on for the booking first, or arrange payment with the member directly."
          : "We weren't able to email the link. Please contact the club and we'll help you complete payment.",
      },
      { status: 409 }
    );
  }

  if (transientFailure > 0 && sent === 0 && justSent === 0) {
    // #2258: the booking's email setting could not be read, so the send failed
    // closed. Nothing is wrong with the address and nothing was decided — this
    // is a transient fault, so the wording is cause-free for everyone (an admin
    // gains nothing from "the setting could not be read") and the status says
    // "try again", not "undeliverable".
    return NextResponse.json(
      {
        error:
          "We weren't able to email the link just now. Please try again in a few minutes, or contact the club and we'll help you complete payment.",
      },
      { status: 503 }
    );
  }

  if (suppressed > 0 && sent === 0) {
    // Every recipient address is SES-suppressed (prior bounce/complaint): the
    // link was minted but nothing was delivered, so tell the truth (F25/#1885).
    return NextResponse.json(
      {
        error:
          "We couldn't email your payment link (your email address is undeliverable). Please contact the club.",
      },
      { status: 502 }
    );
  }

  // Mixed outcome: at least one child was emailed and at least one was not.
  // Reporting a bare 200 let the client claim unqualified success for a booking
  // whose guests are not all covered, so say how many did not go out.
  //
  // How many, never why. The cause-specific counts are ADMIN-ONLY, and that
  // includes the FIELD NAMES: a member reading devtools would learn from a
  // `withheld` key alone that the shortfall was deliberate — the same
  // disclosure the error strings are careful to avoid. Non-admins get only the
  // aggregate, which is all the client renders anyway.
  return NextResponse.json({
    sent,
    justSent,
    notDelivered: suppressed + withheld + transientFailure,
    ...(isAdmin ? { suppressed, withheld, transientFailure } : {}),
  });
}
