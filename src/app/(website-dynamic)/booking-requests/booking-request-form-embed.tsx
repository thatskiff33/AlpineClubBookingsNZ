import { BookingRequestForm } from "@/app/(website-dynamic)/booking-requests/booking-request-form";
import { ClubTimeProvider } from "@/components/club-time-provider";
import type { ClubIdentity } from "@/config/club-identity-types";
import { clubTimeZone } from "@/lib/club-time/server";

/**
 * The public booking-request form with the club's timezone in scope (CT-4 group
 * E, #2870; epic #2988; INV-CONFIG-002).
 *
 * ## Why this wrapper exists at all
 *
 * The form's earliest selectable lodge night is the CLUB'S today, so since CT-4
 * it reads the zone from `ClubTimeProvider` — and on both of the places it
 * normally renders (`/booking-requests`, and any published page carrying the
 * `{{booking-requests}}` token) it already has one, because
 * `website/website-chrome.tsx` mounts it for both public route groups.
 *
 * `/404` IS THE EXCEPTION, and it is the reason for this file. The root
 * `src/app/not-found.tsx` sits outside both website route groups — it renders
 * under `src/app/layout.tsx` alone — and it renders `EmbeddedPageContentParts`
 * over whatever an admin has published at that path. Put a
 * `{{booking-requests}}` token on the 404 page and the form would render with no
 * provider above it, and `useClubTime()` THROWS rather than falling back, which
 * is a thrown error on the one page whose job is to fail gracefully.
 *
 * That is not a hypothetical: `club-time-provider-mount-census.test.tsx` walks
 * the import graph from every providerless surface and found this one the moment
 * the form was migrated. `skifield-whakapapa-embed.tsx` is the same shape for
 * the same reason, and its docblock carries the rest of the reasoning — chiefly
 * why the await belongs at the BRANCH that needs it rather than turning the
 * synchronous parts renderer into an async one that two suites render directly.
 *
 * Nesting this inside the chrome's provider on a normal website page is
 * harmless: the inner provider wins and carries the identical value.
 */
export async function BookingRequestFormEmbed({
  club,
}: {
  club: ClubIdentity;
}) {
  return (
    <ClubTimeProvider zone={await clubTimeZone()}>
      <BookingRequestForm club={club} />
    </ClubTimeProvider>
  );
}
