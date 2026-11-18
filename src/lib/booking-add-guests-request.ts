// The request body for `POST /api/bookings/[id]/guests`, moved verbatim from
// that route to keep it under its size ceiling (#5145).
import { z } from "zod";

import { hostingCoverageOverrideSchema } from "@/lib/adult-member-hosting-same-owner";
import { bookableAgeTierEnum } from "@/lib/age-tier-schema";
import { GUEST_CHANGE_LIST_BOUND } from "@/lib/booking-guest-stay-range-input";
import { nameField } from "@/lib/zod-helpers";

export const addGuestsSchema = z.object({
  guests: z
    .array(
      z.object({
        firstName: nameField(),
        lastName: nameField(),
        ageTier: bookableAgeTierEnum,
        isMember: z.boolean(),
        memberId: z.string().min(1).optional(),
      })
    )
    .min(1).max(...GUEST_CHANGE_LIST_BOUND),
  // #1769b (#1705 semantics): per-action member-email choice on this
  // dual-actor route. Absent = notify (default); false suppresses the
  // booking-modified email. Only an admin actor may carry it (403 gate
  // below); a non-boolean value is rejected with the schema 400.
  notifyMember: z.boolean().optional(),
  // #2576 §7: the officer's explicit confirmation and mandatory reason for
  // overriding a same-owner coverage refusal. Optional in the shape because the
  // first submission never carries it — the officer is asked only when the add
  // would actually strand another booking on the account.
  hostingCoverageOverride: hostingCoverageOverrideSchema.optional(),
});
