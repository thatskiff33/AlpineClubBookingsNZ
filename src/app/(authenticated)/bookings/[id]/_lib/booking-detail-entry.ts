import { hasAdminAccess } from "@/lib/access-roles";
import { prisma } from "@/lib/prisma";
import { loadBookingDetail, type BookingDetailRecord } from "./load-booking-detail";
import {
  removedBookingEntitledViewerWhere,
  type BookingDetailSession,
} from "./booking-detail-viewer";

export type BookingDetailEntry =
  /** The booking to render; the page's own viewer guard still runs on it. */
  | { kind: "FOUND"; booking: BookingDetailRecord }
  /** Removed, and this viewer owns it or is a guest on it: explain, don't 404. */
  | { kind: "REMOVED_FOR_VIEWER" }
  /** Never existed, or removed and this viewer is not entitled to know. */
  | { kind: "NOT_FOUND" };

/**
 * WHAT THE BOOKING PAGE OPENS WITH (owner decision 20 Nov 2026, #5266;
 * `INV-ADDPAY-034`).
 *
 * A Full Admin keeps the record view of a removed booking, as before. Anybody
 * else reads the booking with removed rows excluded, so a removed booking loads
 * nothing — not even its relations — for a viewer who may not see it. Then ONE
 * narrow existence check runs, whose `where` already demands that the viewer
 * own the booking or be a guest on it: a hit is the only thing that can turn
 * "not found" into "removed".
 *
 * WHY THE TWO "NOT FOUND" PATHS ARE THE SAME CALLS. A booking that never existed
 * and a removed booking this viewer is not entitled to both run exactly the
 * same two queries with the same arguments and both come back `NOT_FOUND`, so
 * a guessed or forwarded id tells a stranger nothing — not by the page, not by
 * the number of round trips. Only the RESULT of the second query differs, and
 * it differs only for an entitled viewer.
 */
export async function resolveBookingDetailEntry({
  id,
  session,
}: {
  id: string;
  session: BookingDetailSession;
}): Promise<BookingDetailEntry> {
  const isAdmin = hasAdminAccess(session.user);
  const booking = await loadBookingDetail(id, { includeDeleted: isAdmin });
  if (booking) return { kind: "FOUND", booking };
  if (isAdmin) return { kind: "NOT_FOUND" };

  const removedForViewer = await prisma.booking.findFirst({
    where: removedBookingEntitledViewerWhere(id, session.user.id),
    select: { id: true },
  });
  return removedForViewer ? { kind: "REMOVED_FOR_VIEWER" } : { kind: "NOT_FOUND" };
}
