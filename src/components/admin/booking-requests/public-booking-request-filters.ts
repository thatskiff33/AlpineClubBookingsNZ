// The public booking request queue's filter values and their guard, moved
// verbatim from `public-booking-requests-panel.tsx` so that file shrinks below
// its length on main (#4926: past the hard ceiling a file may only stay or
// shrink). Pure data: no state, no fetch.

export type PublicRequestFilter =
  | "QUEUE"
  | "NEW"
  | "VERIFIED"
  | "PRICED"
  | "QUOTED"
  | "QUOTE_SENT"
  | "QUERY_PENDING"
  | "MODIFICATION_REQUESTED"
  | "ACCEPTED"
  | "APPROVED"
  | "DECLINED"
  | "CANCELLED"
  | "CONVERTED"
  | "ALL";

const publicRequestFilters = new Set<PublicRequestFilter>([
  "QUEUE",
  "NEW",
  "VERIFIED",
  "PRICED",
  "QUOTED",
  "QUOTE_SENT",
  "QUERY_PENDING",
  "MODIFICATION_REQUESTED",
  "ACCEPTED",
  "APPROVED",
  "DECLINED",
  "CANCELLED",
  "CONVERTED",
  "ALL",
]);

export function isPublicRequestFilter(value: string | null): value is PublicRequestFilter {
  return publicRequestFilters.has(value as PublicRequestFilter);
}
