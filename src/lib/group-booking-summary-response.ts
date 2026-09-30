/**
 * The public group summary exactly as `GET /api/group-bookings/[code]` sends
 * it, and the one serialiser that builds it (#3672 review, `INV-SSOT`).
 *
 * The response type is DERIVED from `GroupBookingSummary`, key for key, with
 * each `Date` turned into its ISO string. So a field added to the summary and
 * left out here fails to compile, and the join pages read the same type the
 * route writes instead of a hand-kept copy. Before this, the route built its
 * JSON field by field and silently dropped `joinerPaymentMode`, so the member
 * join page described every group wrongly and lost the Internet Banking
 * choice for each-pays joiners.
 *
 * Client-safe: the only import is a type, erased at build.
 */
import type { GroupBookingSummary } from "@/lib/group-booking";

type AsJson<T> = {
  [K in keyof T]: T[K] extends Date
    ? string
    : T[K] extends Date | null
      ? string | null
      : T[K];
};

export type GroupBookingSummaryResponse = AsJson<GroupBookingSummary>;

export function toGroupBookingSummaryResponse(
  summary: GroupBookingSummary
): GroupBookingSummaryResponse {
  return {
    code: summary.code,
    status: summary.status,
    paymentMode: summary.paymentMode,
    joinerPaymentMode: summary.joinerPaymentMode,
    organiserFirstName: summary.organiserFirstName,
    lodgeName: summary.lodgeName,
    checkIn: summary.checkIn.toISOString(),
    checkOut: summary.checkOut.toISOString(),
    joinDeadline: summary.joinDeadline?.toISOString() ?? null,
    isJoinable: summary.isJoinable,
  };
}
