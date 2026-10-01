import { NextRequest, NextResponse } from "next/server";
import {
  getBookingRequestSettings,
  getPublicBookingRequestLodges,
  getPublicOtherLodges,
} from "@/lib/booking-request";
import { loadSchoolGroupSoftCap } from "@/lib/lodge-settings";
import { getCachedDefaultLodgeCapacity } from "@/lib/public-layout-config";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";

/**
 * Public read of the booking request pricing visibility setting, used by the
 * non-member booking request form to decide between "Request to Book" (with
 * indicative pricing) and "Request for Price" (no pricing shown). This route
 * projects the existing public settings deliberately: the school teacher
 * hut-leader policy stays on the authenticated admin route.
 *
 * Also lists the ACTIVE lodges a requester may choose between (id and name
 * only — this endpoint is public). Empty for a single-lodge club, so the
 * forms render no lodge copy (ADR-002 presentation rule).
 *
 * ## Why the default lodge capacity is here (#2818 decision 7)
 *
 * Both public forms cap the guest list. For a multi-lodge club they measure
 * against the CHOSEN lodge, which arrives in `lodges` above. For a single-lodge
 * club there is no selector, so they fall back to `club.lodgeCapacity` — and
 * that prop is only as good as the render path that supplied it.
 *
 * The dedicated `/booking-requests` and `/school-bookings` pages resolve the real
 * figure and spread it over the club identity, so those are right. Every OTHER
 * render path is not: `{{booking-requests}}` embedded on an ordinary CMS page is
 * rendered by `(website)/[...slug]/page.tsx`, which passes the club identity
 * WITHOUT that spread, and the 404 page does the same — so the form silently
 * measured against the static fallback of 20, which is the #1982 R1 regression
 * all over again but only on the paths nobody was looking at.
 *
 * Serving the DB-resolved figure from the endpoint the forms ALREADY call makes
 * every render path correct at once, without each one having to remember to
 * inject it. It is additive: an older client that ignores the field keeps its
 * previous behaviour exactly. The server-side spread on the dedicated pages
 * stays, because it is what makes the first painted frame right rather than the
 * frame after this fetch resolves.
 *
 * `getCachedDefaultLodgeCapacity` is deliberately the SAME cached read the
 * dedicated pages use, so the server-rendered number and the fetched one cannot
 * disagree and make the cap visibly jump.
 *
 * Not sensitive: the capacity is published on the public rules and terms pages,
 * and the server re-validates every submission per lodge regardless.
 */
export async function GET(request: NextRequest) {
  const rateLimited = await applyRateLimit(rateLimiters.bookingQuery, request);
  if (rateLimited) return rateLimited;

  const [settings, lodges, otherLodges, schoolGroupSoftCap, defaultLodgeCapacity] =
    await Promise.all([
      getBookingRequestSettings(),
      getPublicBookingRequestLodges(),
      // Other/partner lodges for the "member of another lodge?" drop-down (#2749).
      getPublicOtherLodges(),
      // Default-lodge soft cap for the single-lodge case (no lodge selector);
      // multi-lodge forms read the per-lodge value from `lodges` instead.
      loadSchoolGroupSoftCap(),
      getCachedDefaultLodgeCapacity(),
    ]);
  return NextResponse.json({
    showPricingToNonMembers: settings.showPricingToNonMembers,
    quoteResponseTtlDays: settings.quoteResponseTtlDays,
    quoteReminderLeadDays: settings.quoteReminderLeadDays,
    attendeeConfirmationLeadDays: settings.attendeeConfirmationLeadDays,
    attendeeConfirmationReminderDays: settings.attendeeConfirmationReminderDays,
    lodges,
    otherLodges,
    schoolGroupSoftCap,
    defaultLodgeCapacity,
  });
}
