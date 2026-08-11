import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { BookingRequestStatus } from "@prisma/client";
import {
  buildBookingRequestListWhere,
  readBookingRequestGuestsForDisplay,
  serializeBookingRequestForAdmin,
} from "@/lib/booking-request";
import { readBookingRequestQuoteOptionsForDisplay } from "@/lib/booking-request-quotes";
import {
  resolveSuggestedGuestNightRatesForRequests,
  type SuggestedGuestNightRates,
} from "@/lib/booking-request-suggested-rates";
import { resolveWholeLodgeFlatPricesForRequests } from "@/lib/school-booking-request";
import { loadSchoolGroupSoftCap } from "@/lib/lodge-settings";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import logger from "@/lib/logger";

const statusFilterValues = [
  ...Object.values(BookingRequestStatus),
  "QUEUE",
  "ALL",
] as const;

const querySchema = z.object({
  status: z.enum(statusFilterValues).optional().default("QUEUE"),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
});

export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { status, page, pageSize } = parsed.data;
  const where = buildBookingRequestListWhere(status);

  const [requests, total] = await Promise.all([
    prisma.bookingRequest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: pageSize,
      skip: (page - 1) * pageSize,
      // Lodge name for the queue display; null lodgeId means the club's
      // default lodge (pre-multi-lodge rows and single-lodge submissions).
      // otherLodge name (#2749) drives the "Member of another Lodge" line and
      // the Full-member rate pre-fill in the pricing panel.
      include: {
        lodge: { select: { name: true } },
        otherLodge: { select: { name: true } },
      },
    }),
    prisma.bookingRequest.count({ where }),
  ]);

  const reviewerIds = Array.from(
    new Set(
      requests.flatMap((request) => [
        request.pricedByMemberId,
        request.reviewedByMemberId,
        request.convertedMemberId,
        // #2263: the member who submitted a whole-lodge request, so the queue
        // can name them on the "Member" badge row.
        request.requestedByMemberId,
      ])
    )
  ).filter((id): id is string => Boolean(id));

  const reviewers = reviewerIds.length
    ? await prisma.member.findMany({
        where: { id: { in: reviewerIds } },
        select: { id: true, firstName: true, lastName: true },
      })
    : [];
  const reviewerNames = new Map(
    reviewers.map((member) => [member.id, `${member.firstName} ${member.lastName}`])
  );
  const latestQuotes = requests.length
    ? await prisma.bookingRequestQuote.findMany({
        where: { bookingRequestId: { in: requests.map((request) => request.id) } },
        distinct: ["bookingRequestId"],
        orderBy: [{ bookingRequestId: "asc" }, { version: "desc" }],
      })
    : [];
  const latestQuoteByRequestId = new Map(
    latestQuotes.map((quote) => [quote.bookingRequestId, quote])
  );

  // Resolve the school-group soft cap per request lodge through the same
  // settings path enforcement uses (loadSchoolGroupSoftCap), so the queue's
  // "Over N" hint can't diverge from the actual per-lodge threshold. A null
  // lodgeId means the club's default lodge, which resolves to the legacy row —
  // byte-identical to the previous DEFAULT_SCHOOL_GROUP_SOFT_CAP for a
  // single-lodge club with no override. Resolved once per distinct lodge (not
  // per request) to keep the query count flat as the queue grows.
  const distinctLodgeIds = Array.from(
    new Set(requests.map((request) => request.lodgeId))
  );
  const softCapByLodgeId = new Map(
    await Promise.all(
      distinctLodgeIds.map(
        async (lodgeId) =>
          [lodgeId, await loadSchoolGroupSoftCap(prisma, lodgeId)] as const
      )
    )
  );

  // #2338: for member whole-lodge requests, preview the per-season flat
  // whole-lodge price so the approve panel can offer the "price as whole lodge"
  // toggle only when a flat rate actually covers the stay, and show the officer
  // the figure the approval will charge. Null (no flat rate covers the stay) =>
  // no toggle, per-guest pricing as before. Batched: one season query per
  // distinct lodge, and only for the whole-lodge subset of the page.
  const wholeLodgeFlatByRequestId = await resolveWholeLodgeFlatPricesForRequests(
    requests
      .filter((request) => request.requestedByMemberId && request.exclusivityRequested)
      .map((request) => ({
        id: request.id,
        checkIn: request.checkIn,
        checkOut: request.checkOut,
        lodgeId: request.lodgeId,
      }))
  );

  // #2749: suggested per-guest-night rates (non-member + Full-member per tier)
  // so the pricing panel can pre-fill the rate fields. Batched by lodge; pure
  // rate resolution after the season load. Advisory only: if the fee/season
  // lookup fails for any reason it must NOT take down the whole queue (same
  // tolerance as the malformed-blob handling below, #2342) — degrade to no
  // pre-fill and let the officer enter rates by hand.
  let suggestedRatesByRequestId = new Map<string, SuggestedGuestNightRates>();
  try {
    suggestedRatesByRequestId = await resolveSuggestedGuestNightRatesForRequests(
      requests.map((request) => ({
        id: request.id,
        lodgeId: request.lodgeId,
        checkIn: request.checkIn,
        guests: readBookingRequestGuestsForDisplay(request.guests).guests,
      })),
    );
  } catch (error) {
    logger.error(
      { err: error },
      "Failed to resolve suggested guest-night rates; serving the queue without pre-fill",
    );
  }

  const data = requests.map((request) => {
    const quote = latestQuoteByRequestId.get(request.id) ?? null;
    // #2342: the third stored blob this page parses per row, and — once the
    // guest list and the member links were made tolerant — the last one that
    // could still 500 every filter on the whole page over a single corrupt
    // row. Same display tolerance: the row serialises with its quote details
    // OMITTED and a needs-attention flag, instead of throwing. Everything that
    // ACTS on a quote (send, hold, the requester's accept, the expiry cron)
    // keeps using the strict parseBookingRequestQuoteOptions and keeps
    // refusing.
    const quoteDisplay = quote
      ? readBookingRequestQuoteOptionsForDisplay(quote.options)
      : null;
    return {
      ...serializeBookingRequestForAdmin(request),
      schoolGroupSoftCap: softCapByLodgeId.get(request.lodgeId)!,
      pricedByMemberName: request.pricedByMemberId
        ? reviewerNames.get(request.pricedByMemberId) ?? null
        : null,
      reviewedByMemberName: request.reviewedByMemberId
        ? reviewerNames.get(request.reviewedByMemberId) ?? null
        : null,
      requestedByMemberName: request.requestedByMemberId
        ? reviewerNames.get(request.requestedByMemberId) ?? null
        : null,
      latestQuote:
        quote && quoteDisplay
          ? {
              id: quote.id,
              version: quote.version,
              status: quote.status,
              pricingMode: quote.pricingMode,
              sentAt: quote.sentAt?.toISOString() ?? null,
              responseTokenExpiresAt:
                quote.responseTokenExpiresAt?.toISOString() ?? null,
              options: quoteDisplay.options,
            }
          : null,
      // Emitted only when THIS blob failed, alongside the serialiser's own
      // per-blob guest/link flags, so the panel states exactly what is wrong.
      ...(quoteDisplay?.needsAttention ? { quoteDataNeedsAttention: true } : {}),
      // #2338: the flat whole-lodge price for a member whole-lodge request, or
      // null when none is configured for the covering season(s). The panel only
      // offers the "price as whole lodge" toggle when this is non-null.
      wholeLodgeFlatTotalCents:
        wholeLodgeFlatByRequestId.get(request.id) ?? null,
      // #2749: per-tier non-member + Full-member nightly rates for the pricing
      // panel's pre-fill.
      suggestedGuestNightRates:
        suggestedRatesByRequestId.get(request.id) ?? {},
    };
  });

  return NextResponse.json({ data, page, pageSize, total });
}
