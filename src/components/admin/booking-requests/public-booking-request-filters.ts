// The public booking request queue's filter labels, moved verbatim from
// `public-booking-requests-panel.tsx` so that file stays below its length on
// main (#4926: past the hard ceiling a file may only stay or shrink). The
// filter values themselves are `PublicBookingRequestFilter`. Pure data.
import type { PublicBookingRequestFilter } from "@/lib/admin-booking-requests-path";

export const FILTER_LABELS: Record<PublicBookingRequestFilter, string> = {
  QUEUE: "Queue",
  NEW: "Awaiting verification",
  VERIFIED: "Verified",
  PRICED: "Priced",
  QUOTED: "Quoted",
  QUOTE_SENT: "Quote sent",
  QUERY_PENDING: "Query",
  MODIFICATION_REQUESTED: "Modify",
  ACCEPTED: "Accepted",
  APPROVED: "Approved",
  DECLINED: "Declined",
  CANCELLED: "Cancelled",
  CONVERTED: "Converted",
  ALL: "All",
};
