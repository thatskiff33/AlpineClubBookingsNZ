import { ClubTimeProvider } from "@/components/club-time-provider";
import { SchoolBookingForm } from "@/app/(website-dynamic)/school-bookings/school-booking-form";
import type { ClubIdentity } from "@/config/club-identity-types";
import { clubFormatValues } from "@/lib/club-format-server";
import { clubTimeZone } from "@/lib/club-time/server";

/**
 * The public school-booking form with the club's timezone in scope (CT-4 group
 * E, #2870; epic #2988; INV-CONFIG-002).
 *
 * The twin of `booking-requests/booking-request-form-embed.tsx`, for the same
 * reason and with the same one sentence of substance: this form's earliest
 * selectable stay date is the CLUB'S today, it reads that zone from
 * `ClubTimeProvider`, and the root 404 renders `EmbeddedPageContentParts`
 * outside both public route groups — so a `{{school-bookings}}` token published
 * at that path would reach `useClubTime()` with no provider above it and throw.
 *
 * See that file's docblock for the full reasoning, including why the await
 * belongs at this branch rather than in the parts renderer.
 */
export async function SchoolBookingFormEmbed({
  club,
}: {
  club: ClubIdentity;
}) {
  // The zone and the locale are resolved together (#3566): this mount sits
  // outside both chromes on the root 404, so nothing above it carries either.
  const [zone, format] = await Promise.all([clubTimeZone(), clubFormatValues()]);
  return (
    <ClubTimeProvider zone={zone} locale={format.locale}>
      <SchoolBookingForm club={club} />
    </ClubTimeProvider>
  );
}
