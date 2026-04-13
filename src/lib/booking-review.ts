import { AgeTier } from "@prisma/client";

export const ADULT_SUPERVISION_REVIEW_REASON =
  "This booking does not include an adult guest, so it should be reviewed by an admin.";

export function requiresAdultSupervisionReview(
  guests: Array<{ ageTier: AgeTier | string }>
): boolean {
  const hasAdult = guests.some((guest) => guest.ageTier === AgeTier.ADULT);
  const hasMinor = guests.some((guest) =>
    guest.ageTier === AgeTier.CHILD ||
    guest.ageTier === AgeTier.YOUTH ||
    guest.ageTier === AgeTier.INFANT
  );

  return hasMinor && !hasAdult;
}
