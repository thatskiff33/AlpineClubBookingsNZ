/**
 * #4851 review (`INV-PAY-152`): the durable mark a Stuck States "Try the card
 * again" leaves on a given-up organiser child refund debt. The re-arm restarts
 * attempts at 0, so without it the executor could not tell, once the refund
 * goes through, that the owed money is now back. Beside the reopen's own mark
 * (`organiserChildRefundWasReopened` in `organiser-child-refund.ts`).
 */
import type { Prisma } from "@prisma/client";

/**
 * #4851 review: the plan a Stuck States "Try the card again" leaves on a
 * given-up debt. The re-arm restarts its attempts at 0, as the reopen does, so
 * the slice carries `rearmedAt` and the executor still says, once the money
 * goes back, that an earlier attempt failed (`organiserChildRefundWasRearmed`).
 * Every other field is kept, so the reopen marker survives a re-arm.
 */
export function organiserChildRefundRearmedPlan(allocationPlan: Prisma.JsonValue, at: Date): Prisma.InputJsonValue {
  if (!Array.isArray(allocationPlan)) throw new Error("organiserChildRefundRearmedPlan: a per-joiner debt always carries its allocation slice");
  return allocationPlan.map((slice) =>
    typeof slice === "object" && slice !== null && !Array.isArray(slice) ? { ...slice, rearmedAt: at.toISOString() } : slice,
  ) as Prisma.InputJsonValue;
}

/** Whether an officer re-armed this organiser child refund debt after its retries ran out. */
export function organiserChildRefundWasRearmed(allocationPlan: Prisma.JsonValue): boolean {
  return (
    Array.isArray(allocationPlan) &&
    allocationPlan.some(
      (slice) => typeof slice === "object" && slice !== null && !Array.isArray(slice) && typeof slice.rearmedAt === "string",
    )
  );
}
