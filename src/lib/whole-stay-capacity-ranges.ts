/**
 * The capacity ranges for a booking request whose every guest stays the whole
 * request (#3789). Each range carries the guest's linked member, or `null` for
 * a guest no member is linked to, so the capacity check counts a ticked
 * custodian who is also on the booking once rather than twice. Unnamed pending
 * school adults (#3413) are nobody in particular and pass `null`.
 */
import type { CapacityProposedGuest } from "@/lib/capacity";

export function wholeStayCapacityRanges(
  stayStart: Date,
  stayEnd: Date,
  memberIds: ReadonlyArray<string | null>,
): CapacityProposedGuest[] {
  return memberIds.map((memberId) => ({ stayStart, stayEnd, memberId }));
}
