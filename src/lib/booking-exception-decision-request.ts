// The officer decision body for `PATCH /api/admin/booking-exception-requests/[id]`,
// moved verbatim from that route to keep it under its size ceiling (#5145).
import { z } from "zod";

import { hostingCoverageOverrideSchema } from "@/lib/adult-member-hosting-same-owner";

export const decisionSchema = z
  .object({
    action: z.enum(["approve", "reject"]),
    source: z.enum(["MODIFICATION", "NEW_BOOKING"]),
    /**
     * The `version` the officer's screen was showing. A decision made against a
     * stale screen loses the guarded CAS instead of deciding a request that
     * changed underneath it.
     */
    expectedVersion: z.coerce.number().int().min(1),
    /**
     * The MEMBER-FACING decision explanation (#2562). The member reads this on
     * their own request list, and on an approval it is interpolated into the
     * approval email — so the officer screen says so beside the field, and this
     * field name is deliberately unchanged from #2526 rather than renamed, which
     * would have silently repointed every existing decision.
     */
    adminNotes: z.string().trim().max(2000).optional(),
    /**
     * The officer's PRIVATE note (#2562). Stored on its own column and read only
     * by admin-guarded surfaces. It is never a substitute for the member-facing
     * explanation: a refusal still requires `adminNotes`, so an officer cannot
     * refuse a request with an internal note and nothing for the member.
     */
    internalNotes: z.string().trim().max(2000).optional(),
    /**
     * Explicit confirmation that the officer means to apply the reviewed
     * override. Required on approve — an approval creates or rewrites a real
     * booking, so it is never a single mis-click.
     */
    confirm: z.boolean().optional(),
    /** How a refund arising from an approved modification is settled. */
    settlementMethod: z.enum(["card", "credit"]).optional(),
    /**
     * Second-step confirmation for a modification that would strand another
     * same-owner booking. The first attempt deliberately omits it so the
     * canonical service can identify the exact affected bookings and nights.
     */
    hostingCoverageOverride: hostingCoverageOverrideSchema.optional(),
  })
  .strict();
