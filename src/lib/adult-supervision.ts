import {
  isGuestOperationallyPresent,
  type GuestWithConsent,
} from "@/lib/member-guest-consent";

/**
 * THE adult-supervision rule — the one copy, client-safe (no Prisma values, no
 * server reads), so the create service, the create route, the edit and add-guest
 * doors, the member booking wizard, the admin booking page and the edit panel
 * all ask the same question (`INV-SSOT-001`; #3770). `booking-review.ts`
 * re-exports it for the server callers.
 *
 * Minors with no adult go to review (#1100, #1422). The adult must be
 * operationally present (D-12): a member guest still waiting to agree, who may
 * never come, is not the responsible adult — the same rule the paid-up-adult
 * requirement applies (#3770, owner decision "only agreed adults count"). Each
 * row must STATE its consent (`GuestWithConsent`; `null` for a guest who never
 * needed any), so a consent-free view does not type-check. A client states the
 * consent its add will PRODUCE (the wizard's consent preview): pending where the
 * club asks first, confirmed where it only notifies or an officer adds. Minors
 * count whatever their consent, as they always have.
 */
export function requiresAdultSupervisionReview(
  guests: ReadonlyArray<{ ageTier: string } & GuestWithConsent>,
): boolean {
  const hasAdult = guests.some(
    (guest) => guest.ageTier === "ADULT" && isGuestOperationallyPresent(guest),
  );
  const hasMinor = guests.some(
    (guest) =>
      guest.ageTier === "CHILD" ||
      guest.ageTier === "YOUTH" ||
      guest.ageTier === "INFANT",
  );
  return hasMinor && !hasAdult;
}
