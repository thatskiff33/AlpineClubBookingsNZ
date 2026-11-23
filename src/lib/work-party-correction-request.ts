/**
 * The request body of `/api/admin/bookings/[id]/work-party` (fork triyder/AlpineClubBookingsNZ#119): a
 * preview or an apply of "Add to work party", or with `action: "remove"` of
 * "Remove from work party" (fork triyder/AlpineClubBookingsNZ#130). Kept beside the service it feeds
 * (`work-party-booking-correction.ts`) so the route stays a thin door.
 */
import { z } from "zod";

const centsField = z.number().int().min(-100_000_000).max(100_000_000);

// The officer's settlement choice (triyder/AlpineClubBookingsNZ#129); absent is the default (club credit,
// or the organiser's disposition). The service refuses one it does not offer.
const settlementMethodField = z.enum(["credit", "card"]).optional();

// fork triyder/AlpineClubBookingsNZ#130: "remove" takes the booking off the work party; absent is "add". A
// removal hands nothing back, so it carries no settlement method.
const actionField = z.enum(["add", "remove"]).default("add");

export const workPartyCorrectionBodySchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("preview"),
    action: actionField,
    workPartyEventId: z.string().min(1),
    settlementMethod: settlementMethodField,
  }),
  z.object({
    mode: z.literal("apply"),
    action: actionField,
    workPartyEventId: z.string().min(1),
    settlementMethod: settlementMethodField,
    notifyMember: z.boolean().optional(),
    // The figures the officer was shown by the preview; the save refuses if
    // the booking would now come out differently (#4030 C4).
    expectedFigures: z.object({
      previousFinalPriceCents: centsField,
      newFinalPriceCents: centsField,
      priceDiffCents: centsField,
      changeFeeCents: centsField.default(0), // absent from a dialog served before #5149's review: a correction's fee is 0
      accountCreditAmountCents: centsField,
      appliedCreditGivenBackCents: centsField,
      refundedExcessCreditCents: centsField,
      additionalAmountCents: centsField,
      billedToOrganiserCents: centsField.default(0), // absent from a dialog served before fork triyder/AlpineClubBookingsNZ#130: it is 0 on an Add
      refundAmountCents: centsField,
      settlementMethod: z.enum(["card", "credit"]).nullable(),
    }),
  }),
]).refine((body) => body.action === "add" || body.settlementMethod === undefined, {
  message: "A removal hands nothing back, so it takes no settlement method.",
  path: ["settlementMethod"],
});
