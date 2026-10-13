import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  CENTRAL_AVAILABILITY_MAX_DAYS_AHEAD,
  CENTRAL_AVAILABILITY_MAX_NIGHTS,
  freeBedsForStay,
} from "@/lib/central-availability";
import { resolveLocalLodgeForCentralId } from "@/lib/central-lodge-link";
import { SERVERNZ_PUSH_SECRET_KEY } from "@/lib/club-post-mirror";
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import {
  addDaysDateOnly,
  eachDateOnlyInRange,
  isDateOnlyString,
  parseDateOnly,
} from "@/lib/date-only";
import { getIntegrationCredentialValue } from "@/lib/integration-credentials";
import { OWNED_CENTRAL_LODGE_ID_MAX } from "@/lib/other-lodges";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { loadServerNzSettings } from "@/lib/servernz-settings";
import {
  centralAvailabilitySignedText,
  SERVERNZ_SIGNATURE_HEADER,
  SERVERNZ_TIMESTAMP_HEADER,
  verifyServerNzSignature,
} from "@/lib/servernz-signature";

/**
 * The Alpine Central Server asks how many beds are free (#62).
 *
 * Its public lodge search shows non-members which lodges have room before they
 * click through to book on the lodge's own site. This answers ONE number for
 * ONE lodge and stay — the fewest free beds on any night of it, as the member
 * calendar counts them (`freeBedsForStay`) — and nothing else: no guest,
 * member, booking, hold or per-night detail.
 *
 * Unauthenticated by nature, so the request proves itself with the push secret
 * this install was issued (`verifyServerNzSignature`, shared with the
 * shared-post doorbell). What is signed is built from the PARSED query —
 *
 *     availability\n<lodgeId>\n<from>\n<to>
 *
 * — not from the URL, so a reverse proxy re-encoding the address cannot break
 * it, and it can never equal a push body (JSON, beginning `{`), so a captured
 * signature from one route is refused by the other (owner decision D1).
 *
 * Every refusal that could reveal something about this club's lodges reads
 * the same: an unknown, unowned, unlinked or inactive lodge, and a club that
 * has switched off Other lodges sharing, are all one 404.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dateOnly = z.string().refine(isDateOnlyString, "Use a real calendar date as YYYY-MM-DD");
const querySchema = z.object({
  lodgeId: z.string().min(1).max(OWNED_CENTRAL_LODGE_ID_MAX),
  from: dateOnly,
  to: dateOnly,
});

const NOT_FOUND = { error: "Lodge not available" } as const;
const noStore = { "Cache-Control": "no-store" };

export async function GET(request: NextRequest) {
  // The general API limiter (100 a minute per caller address): only the central
  // server gets past the signature, and this bounds what a burst of public
  // searches there can ask of this site.
  const limited = await applyRateLimit(rateLimiters.api, request);
  if (limited) return limited;

  const secret = await getIntegrationCredentialValue("servernz", SERVERNZ_PUSH_SECRET_KEY);
  if (!secret) {
    // Never registered (the Communication Portal is off or was never set up),
    // so nothing can verify. The central server shows "beds available unknown".
    return NextResponse.json({ error: "Not registered" }, { status: 401, headers: noStore });
  }

  // The DECODED values as received: `searchParams` has already undone the
  // URL's percent-encoding, which is what makes the signature immune to a proxy
  // re-encoding the address. The signature is checked BEFORE the query is
  // judged, so an unsigned caller learns nothing from a 400 versus a 401.
  const params = request.nextUrl.searchParams;
  const raw = {
    lodgeId: params.get("lodgeId") ?? "",
    from: params.get("from") ?? "",
    to: params.get("to") ?? "",
  };
  const verified = verifyServerNzSignature({
    secret,
    timestamp: request.headers.get(SERVERNZ_TIMESTAMP_HEADER) ?? "",
    signature: request.headers.get(SERVERNZ_SIGNATURE_HEADER) ?? "",
    signedText: centralAvailabilitySignedText(raw),
  });
  if (!verified.ok) {
    return NextResponse.json({ error: verified.error }, { status: 401, headers: noStore });
  }
  const parsed = querySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid query" }, { status: 400, headers: noStore });
  }

  const { lodgeId, from, to } = parsed.data;
  const first = parseDateOnly(from);
  const checkOut = parseDateOnly(to);
  const today = await clubTodayDateOnlyInstant();
  // The cap is checked BEFORE the nights are listed, so an absurd check-out
  // costs nothing to refuse.
  const nights =
    checkOut > first && checkOut <= addDaysDateOnly(first, CENTRAL_AVAILABILITY_MAX_NIGHTS)
      ? eachDateOnlyInRange(first, checkOut).length
      : CENTRAL_AVAILABILITY_MAX_NIGHTS + 1;
  if (
    nights < 1 ||
    nights > CENTRAL_AVAILABILITY_MAX_NIGHTS ||
    first < today ||
    first > addDaysDateOnly(today, CENTRAL_AVAILABILITY_MAX_DAYS_AHEAD)
  ) {
    return NextResponse.json({ error: "Invalid stay" }, { status: 400, headers: noStore });
  }

  const settings = await loadServerNzSettings();
  if (!settings.otherLodgesEnabled) {
    return NextResponse.json(NOT_FOUND, { status: 404, headers: noStore });
  }
  const localLodgeId = await resolveLocalLodgeForCentralId(
    lodgeId,
    settings.otherLodgesOwnedLodges,
  );
  if (!localLodgeId) {
    return NextResponse.json(NOT_FOUND, { status: 404, headers: noStore });
  }

  const freeBeds = await freeBedsForStay(localLodgeId, first, checkOut);
  return NextResponse.json({ lodgeId, from, to, freeBeds }, { headers: noStore });
}
